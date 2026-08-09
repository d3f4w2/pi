import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { Agent, request as undiciRequest } from "undici";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-api-key",
	"x-subscription-token",
]);

export interface LookupAddress {
	address: string;
	family: number;
}

export interface RawNetworkBody extends AsyncIterable<unknown> {
	on?(event: "error", listener: (error: Error) => void): unknown;
	destroy(error?: Error): void;
}

export interface RawNetworkResponse {
	status: number;
	statusText: string;
	headers: IncomingHttpHeaders | Record<string, string>;
	body: RawNetworkBody;
}

export interface RawRequestOptions {
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
	signal: AbortSignal;
	timeoutMs: number;
}

export interface NetworkDependencies {
	resolve(hostname: string): Promise<LookupAddress[]>;
	request(url: string, options: RawRequestOptions): Promise<RawNetworkResponse>;
}

export interface NetworkRequestOptions {
	url: string;
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
	timeoutSeconds?: number;
	maxBytes: number;
	maxRedirects?: number;
	allowedContentTypes?: readonly string[];
	signal?: AbortSignal;
}

export interface NetworkResource {
	url: string;
	status: number;
	statusText: string;
	contentType: string;
	bytes: number;
	body: Uint8Array;
}

function ipv4Value(address: string): number | undefined {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return undefined;
	}
	return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

function isInIpv4Cidr(value: number, base: number, prefix: number): boolean {
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (value & mask) === (base & mask);
}

function isPublicIpv4(address: string): boolean {
	const value = ipv4Value(address);
	if (value === undefined) return false;
	const blocked: ReadonlyArray<readonly [number, number]> = [
		[0x00000000, 8],
		[0x0a000000, 8],
		[0x64400000, 10],
		[0x7f000000, 8],
		[0xa9fe0000, 16],
		[0xac100000, 12],
		[0xc0000000, 24],
		[0xc0000200, 24],
		[0xc0a80000, 16],
		[0xc6120000, 15],
		[0xc6336400, 24],
		[0xcb007100, 24],
		[0xe0000000, 4],
		[0xf0000000, 4],
	];
	return !blocked.some(([base, prefix]) => isInIpv4Cidr(value, base, prefix));
}

function isBenchmarkingIpv4(address: string): boolean {
	const value = ipv4Value(address);
	return value !== undefined && isInIpv4Cidr(value, 0xc6120000, 15);
}

function parseIpv6(address: string): Uint8Array | undefined {
	let normalized = address.toLowerCase();
	const zoneIndex = normalized.indexOf("%");
	if (zoneIndex !== -1) normalized = normalized.slice(0, zoneIndex);
	if (normalized.includes(".")) {
		const lastColon = normalized.lastIndexOf(":");
		const ipv4 = ipv4Value(normalized.slice(lastColon + 1));
		if (lastColon === -1 || ipv4 === undefined) return undefined;
		normalized = `${normalized.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
	}
	const halves = normalized.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
	const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
	if (groups.length !== 8) return undefined;
	const bytes = new Uint8Array(16);
	for (const [index, group] of groups.entries()) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
		const value = Number.parseInt(group, 16);
		bytes[index * 2] = value >>> 8;
		bytes[index * 2 + 1] = value & 0xff;
	}
	return bytes;
}

function isPublicIpv6(address: string): boolean {
	const bytes = parseIpv6(address);
	if (!bytes) return false;
	const isIpv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
	if (isIpv4Mapped) return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);

	// Only global-unicast IPv6 is useful for public web access.
	if ((bytes[0] ?? 0) < 0x20 || (bytes[0] ?? 0) > 0x3f) return false;
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] ?? 0) < 0x02) return false;
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
	if (bytes[0] === 0x3f && bytes[1] === 0xff && ((bytes[2] ?? 0) & 0xf0) === 0) return false;
	return true;
}

export function isPublicIpAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isPublicIpv4(address);
	if (family === 6) return isPublicIpv6(address);
	return false;
}

function normalizedHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

export function parseSafeHttpUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("网址无效。");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许访问 HTTP 或 HTTPS 网址。");
	if (url.username || url.password) throw new Error("网址不能包含账号或密码。");
	const hostname = normalizedHostname(url.hostname);
	if (!hostname) throw new Error("网址缺少主机名。");
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".home.arpa") ||
		hostname === "metadata.google.internal"
	) {
		throw new Error("不能访问本地或内网地址。");
	}
	if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) throw new Error("不能访问本地或内网地址。");
	return url;
}

export function clampTimeoutSeconds(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_SECONDS;
	return Math.min(Math.ceil(value), MAX_TIMEOUT_SECONDS);
}

async function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
	const normalized = normalizedHostname(hostname);
	if (isIP(normalized) !== 0) return [{ address: normalized, family: isIP(normalized) }];
	return dnsLookup(normalized, { all: true, verbatim: true });
}

async function assertPublicResolution(hostname: string, resolve: NetworkDependencies["resolve"]): Promise<void> {
	const normalized = normalizedHostname(hostname);
	const addresses = await resolve(normalized);
	if (addresses.length === 0) throw new Error(`无法解析网址主机：${hostname}`);
	const hostnameIsDomain = isIP(normalized) === 0;
	if (
		addresses.some(({ address }) => !isPublicIpAddress(address) && !(hostnameIsDomain && isBenchmarkingIpv4(address)))
	) {
		throw new Error("不能访问本地或内网地址。");
	}
}

const secureLookup: LookupFunction = (hostname, options, callback) => {
	resolvePublicAddresses(hostname)
		.then((addresses) => {
			const normalized = normalizedHostname(hostname);
			const hostnameIsDomain = isIP(normalized) === 0;
			if (
				addresses.length === 0 ||
				addresses.some(
					({ address }) => !isPublicIpAddress(address) && !(hostnameIsDomain && isBenchmarkingIpv4(address)),
				)
			) {
				callback(new Error(`不能访问本地或内网地址：${hostname}`), "", 0);
				return;
			}
			if (options.all) callback(null, addresses);
			else {
				const first = addresses[0];
				if (!first) callback(new Error(`无法解析网址主机：${hostname}`), "", 0);
				else callback(null, first.address, first.family);
			}
		})
		.catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), "", 0));
};

const secureAgent = new Agent({ connect: { lookup: secureLookup } });

async function defaultRequest(url: string, options: RawRequestOptions): Promise<RawNetworkResponse> {
	const response = await undiciRequest(url, {
		method: options.method,
		headers: options.headers,
		...(options.body === undefined ? {} : { body: options.body }),
		signal: options.signal,
		headersTimeout: options.timeoutMs,
		bodyTimeout: options.timeoutMs,
		dispatcher: secureAgent,
	});
	return {
		status: response.statusCode,
		statusText: response.statusText,
		headers: response.headers,
		body: response.body,
	};
}

const DEFAULT_DEPENDENCIES: NetworkDependencies = {
	resolve: resolvePublicAddresses,
	request: defaultRequest,
};

function headerValue(headers: RawNetworkResponse["headers"], name: string): string {
	const value = headers[name.toLowerCase()];
	if (Array.isArray(value)) return value.join(", ");
	return value ?? "";
}

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())));
}

function combinedAbortSignal(
	outerSignal: AbortSignal | undefined,
	timeoutSeconds: number,
): {
	signal: AbortSignal;
	cleanup(): void;
} {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error(`联网请求超过 ${timeoutSeconds} 秒。`)),
		timeoutSeconds * 1000,
	);
	const onAbort = (): void => controller.abort(outerSignal?.reason ?? new Error("联网请求已取消。"));
	if (outerSignal?.aborted) onAbort();
	else outerSignal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			outerSignal?.removeEventListener("abort", onAbort);
		},
	};
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("联网请求已取消。");
}

function isRequestAbort(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || ("code" in error && error.code === "UND_ERR_ABORTED");
}

function safelyDestroyBody(body: RawNetworkBody, error?: Error): void {
	body.on?.("error", () => {});
	try {
		body.destroy(error);
	} catch {
		// The response is already being discarded; cleanup errors must not crash the agent.
	}
}

async function readBody(body: RawNetworkBody, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for await (const chunk of body) {
			if (signal.aborted) throw abortError(signal);
			const bytes =
				chunk instanceof Uint8Array
					? chunk
					: typeof chunk === "string"
						? new TextEncoder().encode(chunk)
						: undefined;
			if (!bytes) throw new Error("网页返回了无法识别的数据。");
			total += bytes.length;
			if (total > maxBytes) throw new Error(`网页内容过大，超过 ${Math.ceil(maxBytes / 1024)} KB 限制。`);
			chunks.push(bytes);
		}
	} catch (error) {
		safelyDestroyBody(body, error instanceof Error ? error : undefined);
		throw error;
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

function isAllowedContentType(contentType: string, allowed: readonly string[] | undefined): boolean {
	if (!allowed || !contentType) return true;
	const normalized = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
	return allowed.some((item) => (item.endsWith("/") ? normalized.startsWith(item) : normalized === item));
}

export async function fetchNetworkResource(
	options: NetworkRequestOptions,
	dependencies: NetworkDependencies = DEFAULT_DEPENDENCIES,
): Promise<NetworkResource> {
	if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error("响应大小限制必须是正整数。");
	const timeoutSeconds = clampTimeoutSeconds(options.timeoutSeconds);
	const abort = combinedAbortSignal(options.signal, timeoutSeconds);
	const timeoutMs = timeoutSeconds * 1000;
	let currentUrl = parseSafeHttpUrl(options.url);
	let method = options.method ?? "GET";
	let body = options.body;
	let headers = { ...options.headers };
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

	try {
		for (let redirectCount = 0; ; redirectCount += 1) {
			if (abort.signal.aborted) throw abortError(abort.signal);
			await assertPublicResolution(currentUrl.hostname, dependencies.resolve);
			let response: RawNetworkResponse;
			try {
				response = await dependencies.request(currentUrl.toString(), {
					method,
					headers,
					...(body === undefined ? {} : { body }),
					signal: abort.signal,
					timeoutMs,
				});
			} catch (error) {
				if (abort.signal.aborted) throw abortError(abort.signal);
				if (isRequestAbort(error)) throw new Error("网页连接被中断。");
				throw error;
			}
			const location = headerValue(response.headers, "location");
			if (REDIRECT_STATUSES.has(response.status) && location) {
				safelyDestroyBody(response.body);
				if (redirectCount >= maxRedirects) throw new Error(`网页跳转次数超过 ${maxRedirects} 次。`);
				const nextUrl = parseSafeHttpUrl(new URL(location, currentUrl).toString());
				if (nextUrl.origin !== currentUrl.origin) headers = stripSensitiveHeaders(headers);
				if (
					response.status === 303 ||
					((response.status === 301 || response.status === 302) && method === "POST")
				) {
					method = "GET";
					body = undefined;
					headers = Object.fromEntries(
						Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"),
					);
				}
				currentUrl = nextUrl;
				continue;
			}

			const contentLength = Number.parseInt(headerValue(response.headers, "content-length"), 10);
			if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
				safelyDestroyBody(response.body);
				throw new Error(`网页内容过大，超过 ${Math.ceil(options.maxBytes / 1024)} KB 限制。`);
			}
			const contentType = headerValue(response.headers, "content-type");
			if (!isAllowedContentType(contentType, options.allowedContentTypes)) {
				safelyDestroyBody(response.body);
				throw new Error(`不支持这种网页内容：${contentType || "未知类型"}`);
			}
			const responseBody = await readBody(response.body, options.maxBytes, abort.signal);
			return {
				url: currentUrl.toString(),
				status: response.status,
				statusText: response.statusText,
				contentType,
				bytes: responseBody.length,
				body: responseBody,
			};
		}
	} finally {
		abort.cleanup();
	}
}
