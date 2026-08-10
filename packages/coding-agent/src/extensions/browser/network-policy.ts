import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicIpAddress, type LookupAddress } from "../web/network.ts";

export type BrowserHostResolver = (hostname: string) => Promise<LookupAddress[]>;

function normalizedHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isLoopbackAddress(address: string): boolean {
	const normalized = normalizedHostname(address);
	if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
	if (isIP(normalized) !== 6) return false;
	return normalized === "::1" || /^::ffff:127\./i.test(normalized);
}

function isExplicitLoopbackHostname(hostname: string): boolean {
	const normalized = normalizedHostname(hostname);
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		(isIP(normalized) !== 0 && isLoopbackAddress(normalized))
	);
}

export function parseBrowserHttpUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid browser URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Browser only accepts HTTP or HTTPS URLs.");
	}
	if (url.username || url.password) throw new Error("Browser URL 不能包含账号或密码。");
	const hostname = normalizedHostname(url.hostname);
	if (!hostname) throw new Error("Browser URL is missing a hostname.");
	if (
		hostname === "metadata.google.internal" ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".home.arpa")
	) {
		throw new Error("Browser cannot access local, private, or metadata hostnames.");
	}
	if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname) && !isLoopbackAddress(hostname)) {
		throw new Error("Browser 不能访问私网或元数据等敏感系统地址 (private or metadata address)。");
	}
	return url;
}

function parseBrowserRequestUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid browser request URL.");
	}
	if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
		throw new Error("Browser requests only accept HTTP(S) or WebSocket URLs.");
	}
	const validationUrl = new URL(url.toString());
	if (validationUrl.protocol === "ws:") validationUrl.protocol = "http:";
	if (validationUrl.protocol === "wss:") validationUrl.protocol = "https:";
	parseBrowserHttpUrl(validationUrl.toString());
	return url;
}

async function defaultResolve(hostname: string): Promise<LookupAddress[]> {
	const normalized = normalizedHostname(hostname);
	if (isIP(normalized) !== 0) return [{ address: normalized, family: isIP(normalized) }];
	return dnsLookup(normalized, { all: true, verbatim: true });
}

export class BrowserNetworkPolicy {
	private readonly resolve: BrowserHostResolver;
	private readonly allowedLoopbackOrigins = new Set<string>();

	constructor(resolve: BrowserHostResolver = defaultResolve) {
		this.resolve = resolve;
	}

	async authorizeNavigation(value: string): Promise<URL> {
		const url = parseBrowserHttpUrl(value);
		const access = await this.classify(url);
		if (access === "loopback") {
			this.allowedLoopbackOrigins.add(url.origin);
			const websocketOrigin = new URL(url.toString());
			websocketOrigin.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			this.allowedLoopbackOrigins.add(websocketOrigin.origin);
		}
		return url;
	}

	async assertRequestAllowed(value: string): Promise<void> {
		const url = parseBrowserRequestUrl(value);
		if (this.allowedLoopbackOrigins.has(url.origin) && isExplicitLoopbackHostname(url.hostname)) return;
		const access = await this.classify(url);
		if (access === "loopback") {
			throw new Error("Browser loopback requests require an explicitly navigated matching origin.");
		}
	}

	private async classify(url: URL): Promise<"public" | "loopback"> {
		const hostname = normalizedHostname(url.hostname);
		const addresses = await this.resolve(hostname);
		if (addresses.length === 0) throw new Error(`Browser could not resolve hostname: ${hostname}`);
		if (addresses.every(({ address }) => isLoopbackAddress(address))) {
			if (!isExplicitLoopbackHostname(hostname)) {
				throw new Error("Browser hostname resolved to loopback without an explicit loopback hostname.");
			}
			return "loopback";
		}
		if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
			throw new Error("Browser hostname resolved to a local, private, or metadata address.");
		}
		return "public";
	}
}
