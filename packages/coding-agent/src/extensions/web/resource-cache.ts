import { createHash } from "node:crypto";
import { fetchNetworkResource, type NetworkRequestOptions, type NetworkResource } from "./network.ts";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const SENSITIVE_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-api-key",
	"x-subscription-token",
]);

export type NetworkResourceFetcher = (options: NetworkRequestOptions) => Promise<NetworkResource>;

export interface CachedNetworkResource extends NetworkResource {
	cached: boolean;
	readAt: string;
	contentSha256: string;
}

interface CacheEntry {
	key: string;
	resource: NetworkResource;
	contentSha256: string;
	fetchedAt: number;
	expiresAt: number;
	lastAccessedAt: number;
}

export interface ExternalResourceCacheSnapshot {
	entries: number;
	bytes: number;
	hits: number;
	misses: number;
	revalidations: number;
	evictions: number;
}

export interface ExternalResourceCacheOptions {
	ttlMs?: number;
	maxEntries?: number;
	maxBytes?: number;
	now?: () => number;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function cloneResource(resource: NetworkResource): NetworkResource {
	return { ...resource, body: Uint8Array.from(resource.body) };
}

function hasSensitiveRequest(options: NetworkRequestOptions): boolean {
	try {
		const parsed = new URL(options.url);
		if (parsed.username || parsed.password) return true;
	} catch {
		return true;
	}
	return Object.keys(options.headers ?? {}).some((name) => SENSITIVE_HEADERS.has(name.toLowerCase()));
}

function requestIdentity(options: NetworkRequestOptions): string {
	const headers = Object.entries(options.headers ?? {})
		.filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase()))
		.map(([name, value]) => [name.toLowerCase(), value] as const)
		.sort(([left], [right]) => left.localeCompare(right));
	return sha256(
		JSON.stringify([
			options.method ?? "GET",
			new URL(options.url).toString(),
			headers,
			options.maxBytes,
			options.allowedContentTypes ?? [],
			options.maxRedirects,
			options.body === undefined ? undefined : sha256(options.body),
		]),
	);
}

function toCached(
	resource: NetworkResource,
	cached: boolean,
	readAt: number,
	contentSha256: string,
): CachedNetworkResource {
	return {
		...cloneResource(resource),
		cached,
		readAt: new Date(readAt).toISOString(),
		contentSha256,
	};
}

function waitForSharedResource(
	promise: Promise<CachedNetworkResource>,
	signal: AbortSignal | undefined,
): Promise<CachedNetworkResource> {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(
			signal.reason instanceof Error ? signal.reason : new Error("External resource read canceled."),
		);
	}
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason instanceof Error ? signal.reason : new Error("External resource read canceled."));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(resource) => {
				signal.removeEventListener("abort", onAbort);
				resolve(resource);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export class ExternalResourceCache {
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly now: () => number;
	private readonly entries = new Map<string, CacheEntry>();
	private readonly inFlight = new Map<string, Promise<CachedNetworkResource>>();
	private bytes = 0;
	private hits = 0;
	private misses = 0;
	private revalidations = 0;
	private evictions = 0;

	constructor(options: ExternalResourceCacheOptions = {}) {
		this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS));
		this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
		this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
		this.now = options.now ?? Date.now;
	}

	async fetch(
		options: NetworkRequestOptions,
		fetcher: NetworkResourceFetcher = fetchNetworkResource,
	): Promise<CachedNetworkResource> {
		if (options.signal?.aborted) {
			throw options.signal.reason instanceof Error
				? options.signal.reason
				: new Error("External resource read canceled.");
		}
		if (hasSensitiveRequest(options)) {
			const resource = await fetcher(options);
			return toCached(resource, false, this.now(), sha256(resource.body));
		}
		const key = requestIdentity(options);
		const now = this.now();
		const entry = this.entries.get(key);
		if (entry && entry.expiresAt > now) {
			entry.lastAccessedAt = now;
			this.hits++;
			return toCached(entry.resource, true, now, entry.contentSha256);
		}
		const pending = this.inFlight.get(key);
		if (pending) {
			const result = await waitForSharedResource(pending, options.signal);
			const stored = this.entries.get(key);
			const readAt = this.now();
			if (stored && stored.expiresAt > readAt) {
				stored.lastAccessedAt = readAt;
				this.hits++;
				return toCached(stored.resource, true, readAt, stored.contentSha256);
			}
			return toCached(result, result.cached, readAt, result.contentSha256);
		}

		const { signal: _callerSignal, ...sharedOptions } = options;
		const request = this.fetchAndStore(key, sharedOptions, fetcher);
		this.inFlight.set(key, request);
		void request
			.finally(() => {
				if (this.inFlight.get(key) === request) this.inFlight.delete(key);
			})
			.catch(() => {});
		return waitForSharedResource(request, options.signal);
	}

	private async fetchAndStore(
		key: string,
		options: NetworkRequestOptions,
		fetcher: NetworkResourceFetcher,
	): Promise<CachedNetworkResource> {
		const now = this.now();
		const entry = this.entries.get(key);

		const conditionalHeaders = { ...(options.headers ?? {}) };
		if (entry?.resource.etag) conditionalHeaders["If-None-Match"] = entry.resource.etag;
		if (entry?.resource.lastModified) conditionalHeaders["If-Modified-Since"] = entry.resource.lastModified;
		const hasValidator =
			entry !== undefined && (entry.resource.etag !== undefined || entry.resource.lastModified !== undefined);
		const response = await fetcher({ ...options, headers: conditionalHeaders });
		if (response.status === 304 && entry) {
			entry.expiresAt = now + this.ttlMs;
			entry.fetchedAt = now;
			entry.lastAccessedAt = now;
			this.hits++;
			this.revalidations++;
			return toCached(entry.resource, true, now, entry.contentSha256);
		}
		if (response.status === 304) throw new Error("External resource returned 304 without a cache entry.");
		if (!entry) this.misses++;
		else if (hasValidator) this.revalidations++;
		if (response.status < 200 || response.status >= 300 || response.body.length > this.maxBytes) {
			return toCached(response, false, now, sha256(response.body));
		}

		const contentSha256 = sha256(response.body);
		if (entry) this.remove(entry.key);
		const stored: CacheEntry = {
			key,
			resource: cloneResource(response),
			contentSha256,
			fetchedAt: now,
			expiresAt: now + this.ttlMs,
			lastAccessedAt: now,
		};
		this.entries.set(key, stored);
		this.bytes += stored.resource.body.length;
		this.evict();
		return toCached(response, false, now, contentSha256);
	}

	snapshot(): ExternalResourceCacheSnapshot {
		return {
			entries: this.entries.size,
			bytes: this.bytes,
			hits: this.hits,
			misses: this.misses,
			revalidations: this.revalidations,
			evictions: this.evictions,
		};
	}

	private remove(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.bytes -= entry.resource.body.length;
	}

	private evict(): void {
		while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
			const oldest = [...this.entries.values()].sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)[0];
			if (!oldest) return;
			this.remove(oldest.key);
			this.evictions++;
		}
	}
}

export const externalResourceCache = new ExternalResourceCache();
