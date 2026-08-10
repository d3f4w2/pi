import { describe, expect, it, vi } from "vitest";
import { fetchWebPage } from "../src/extensions/web/fetch.ts";
import type { NetworkRequestOptions, NetworkResource } from "../src/extensions/web/network.ts";
import { parseExternalResourceAddress } from "../src/extensions/web/resource-address.ts";
import { ExternalResourceCache } from "../src/extensions/web/resource-cache.ts";
import { resolveExternalResource, resolveStructuredWebUrl } from "../src/extensions/web/source-adapters.ts";

function networkResource(body: string, overrides: Partial<NetworkResource> = {}): NetworkResource {
	const data = Buffer.from(body, "utf8");
	return {
		url: "https://api.example.test/resource",
		status: 200,
		statusText: "OK",
		contentType: "application/json",
		bytes: data.length,
		body: data,
		...overrides,
	};
}

describe("external resource addresses", () => {
	it.each([
		["github://openai/openai-node", "github", "openai/openai-node"],
		["gitlab://gitlab-org/gitlab", "gitlab", "gitlab-org/gitlab"],
		["gitlab://group/subgroup/project", "gitlab", "group/subgroup/project"],
		["npm://%40types/node", "npm", "@types/node"],
		["pypi://requests", "pypi", "requests"],
		["crates://serde", "crates", "serde"],
		["go-package://golang.org/x/net", "go-package", "golang.org/x/net"],
		["arxiv://2401.01234", "arxiv", "2401.01234"],
		["arxiv://hep-th/9901001", "arxiv", "hep-th/9901001"],
		["osv://GHSA-xxxx-yyyy-zzzz", "osv", "GHSA-xxxx-yyyy-zzzz"],
	] as const)("parses %s", (value, scheme, identifier) => {
		const parsed = parseExternalResourceAddress(value);
		expect(parsed.scheme).toBe(scheme);
		expect(parsed.identifier).toBe(identifier);
		expect(parsed.canonicalAddress).toMatch(new RegExp(`^${scheme}://`));
	});

	it("rejects traversal, fragments, credentials, and malformed operations", () => {
		expect(() => parseExternalResourceAddress("github://owner/repo/file/main/../secret")).toThrow(/path|segment/i);
		expect(() => parseExternalResourceAddress("npm://user:secret@package")).toThrow(/credential/i);
		expect(() => parseExternalResourceAddress("osv://GHSA-test#fragment")).toThrow(/fragment/i);
		expect(() => parseExternalResourceAddress("github://owner/repo/pull/not-a-number")).toThrow(/pull/i);
		expect(() => parseExternalResourceAddress("github://owner/repo/diff/base......head")).toThrow(/diff/i);
	});

	it("uses an explicit GitLab operation delimiter without stealing nested project paths", () => {
		const repository = parseExternalResourceAddress("gitlab://group/subgroup/file/main/path");
		const file = parseExternalResourceAddress("gitlab://group/subgroup/project/-/file/main/src/index.ts");

		expect(repository.identifier).toBe("group/subgroup/file/main/path");
		expect(repository.operation).toBeUndefined();
		expect(file).toMatchObject({ identifier: "group/subgroup/project", operation: "file" });
	});
});

describe("external resource cache", () => {
	it("coalesces concurrent cold reads without corrupting the byte budget", async () => {
		const cache = new ExternalResourceCache({ ttlMs: 60_000, maxEntries: 4, maxBytes: 1 });
		const fetcher = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return networkResource("x", { contentType: "text/plain" });
		});
		const request = { url: "https://api.example.test/concurrent", maxBytes: 1_024 };

		const [first, second] = await Promise.all([cache.fetch(request, fetcher), cache.fetch(request, fetcher)]);
		const third = await cache.fetch(request, fetcher);

		expect(fetcher).toHaveBeenCalledOnce();
		expect([first.cached, second.cached]).toContain(true);
		expect(third.cached).toBe(true);
		expect(cache.snapshot()).toMatchObject({ entries: 1, bytes: 1, misses: 1, hits: 2, evictions: 0 });
	});

	it("measures a cold read followed by nine cache hits", async () => {
		const cache = new ExternalResourceCache({ ttlMs: 60_000, maxEntries: 4, maxBytes: 4_096 });
		const fetcher = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return networkResource('{"fixture":true}', { etag: '"fixture-v1"' });
		});
		const latencies: number[] = [];
		for (let index = 0; index < 10; index++) {
			const startedAt = performance.now();
			await cache.fetch({ url: "https://api.example.test/metric", maxBytes: 1_024 }, fetcher);
			latencies.push(performance.now() - startedAt);
		}
		const summary = {
			requests: latencies.length,
			cacheHitRate: cache.snapshot().hits / latencies.length,
			coldLatencyMs: latencies[0] ?? 0,
			meanHitLatencyMs: latencies.slice(1).reduce((total, latency) => total + latency, 0) / 9,
			fetcherCalls: fetcher.mock.calls.length,
		};
		expect(summary.cacheHitRate).toBe(0.9);
		expect(summary.fetcherCalls).toBe(1);
		expect(summary.meanHitLatencyMs).toBeLessThan(summary.coldLatencyMs);
		console.info("EXTERNAL_RESOURCE_CACHE_METRICS", JSON.stringify(summary));
	});

	it("revalidates stale entries with ETag and keeps credentials out of cache identity", async () => {
		let now = 1_000;
		const cache = new ExternalResourceCache({ ttlMs: 10, now: () => now, maxEntries: 4, maxBytes: 4_096 });
		const fetcher = vi.fn(async (options: NetworkRequestOptions) => {
			if (options.headers?.["If-None-Match"] === '"v1"') {
				return networkResource("", { status: 304, statusText: "Not Modified", bytes: 0, body: new Uint8Array() });
			}
			return networkResource('{"version":1}', { etag: '"v1"' });
		});

		const request = {
			url: "https://api.example.test/resource",
			headers: { Accept: "application/json" },
			maxBytes: 1_024,
		};
		const first = await cache.fetch(request, fetcher);
		const fresh = await cache.fetch(request, fetcher);
		now += 11;
		const revalidated = await cache.fetch(request, fetcher);

		expect(first.cached).toBe(false);
		expect(fresh.cached).toBe(true);
		expect(revalidated.cached).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher.mock.calls[1]?.[0].headers).toMatchObject({ "If-None-Match": '"v1"' });
		expect(cache.snapshot()).toMatchObject({ entries: 1, hits: 2, misses: 1, revalidations: 1 });

		await cache.fetch({ ...request, headers: { Authorization: "Bearer secret" } }, fetcher);
		expect(cache.snapshot().entries).toBe(1);
		expect(JSON.stringify(cache.snapshot())).not.toContain("secret");
	});

	it("separates representations and evicts by byte budget", async () => {
		const cache = new ExternalResourceCache({ ttlMs: 10_000, maxEntries: 4, maxBytes: 20 });
		const fetcher = vi.fn(async (options: NetworkRequestOptions) =>
			networkResource(options.headers?.Accept === "text/plain" ? "plain" : "json"),
		);

		await cache.fetch(
			{ url: "https://api.example.test/x", headers: { Accept: "text/plain" }, maxBytes: 100 },
			fetcher,
		);
		await cache.fetch(
			{ url: "https://api.example.test/x", headers: { Accept: "application/json" }, maxBytes: 100 },
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(cache.snapshot().bytes).toBeLessThanOrEqual(20);
	});

	it("separates response limits and POST bodies to prevent cache pollution", async () => {
		const cache = new ExternalResourceCache({ ttlMs: 10_000, maxEntries: 8, maxBytes: 4_096 });
		const fetcher = vi.fn(async (options: NetworkRequestOptions) => networkResource(options.body ?? "get"));

		await cache.fetch({ url: "https://api.example.test/x", maxBytes: 100 }, fetcher);
		await cache.fetch({ url: "https://api.example.test/x", maxBytes: 10 }, fetcher);
		await cache.fetch({ url: "https://api.example.test/x", method: "POST", body: "one", maxBytes: 100 }, fetcher);
		await cache.fetch({ url: "https://api.example.test/x", method: "POST", body: "two", maxBytes: 100 }, fetcher);

		expect(fetcher).toHaveBeenCalledTimes(4);
	});
});

describe("structured source adapters", () => {
	it("supports nested GitLab namespaces and merge requests", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) => {
			expect(options.url).toBe("https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fproject/merge_requests/42");
			return networkResource('{"iid":42}', { url: options.url });
		});

		const result = await resolveExternalResource("gitlab://group/subgroup/project/-/merge-request/42", {
			fetcher,
			cache: new ExternalResourceCache(),
		});

		expect(result.sourceAddress).toBe("gitlab://group/subgroup/project/-/merge-request/42");
		expect(new TextDecoder().decode(result.data)).toContain('"iid": 42');
	});

	it("maps legacy arXiv URLs to the official Atom API", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) => {
			expect(options.url).toBe("https://export.arxiv.org/api/query?id_list=hep-th%2F9901001");
			return networkResource("<feed><entry><title>Legacy paper</title></entry></feed>", {
				url: options.url,
				contentType: "application/atom+xml",
			});
		});

		const result = await resolveStructuredWebUrl("https://arxiv.org/abs/hep-th/9901001", {
			fetcher,
			cache: new ExternalResourceCache(),
		});

		expect(new TextDecoder().decode(result?.data)).toContain("Legacy paper");
	});

	it("routes web_fetch resource addresses through the official adapter", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) =>
			networkResource('{"name":"react","dist-tags":{"latest":"19.1.0"}}', { url: options.url }),
		);

		const result = await fetchWebPage({
			url: "npm://react",
			format: "text",
			sourceAdapterOptions: { fetcher, cache: new ExternalResourceCache() },
		});

		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0]?.[0].url).toBe("https://registry.npmjs.org/react");
		expect(result.text).toContain('"latest": "19.1.0"');
		expect(result.details).toMatchObject({ sourceAddress: "npm://react", status: 200, untrusted: true });
	});

	it("routes supported official URLs through the structured adapter", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) =>
			networkResource('{"name":"react","dist-tags":{"latest":"19.1.0"}}', { url: options.url }),
		);

		const result = await fetchWebPage({
			url: "https://www.npmjs.com/package/react",
			format: "text",
			timeoutSeconds: 7,
			sourceAdapterOptions: { fetcher, cache: new ExternalResourceCache() },
		});

		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0]?.[0]).toMatchObject({
			url: "https://registry.npmjs.org/react",
			timeoutSeconds: 7,
		});
		expect(result.details.sourceAddress).toBe("npm://react");
	});

	it("downgrades once from an official API to its site parser", async () => {
		const fetcher = vi
			.fn<(options: NetworkRequestOptions) => Promise<NetworkResource>>()
			.mockResolvedValueOnce(networkResource("rate limited", { status: 429, statusText: "Too Many Requests" }))
			.mockImplementationOnce(async (options) =>
				networkResource("<main><h1>requests</h1><p>Official package page</p></main>", {
					url: options.url,
					contentType: "text/html",
				}),
			);

		const result = await resolveExternalResource("pypi://requests", {
			fetcher,
			cache: new ExternalResourceCache(),
		});

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher.mock.calls[0]?.[0].url).toBe("https://pypi.org/pypi/requests/json");
		expect(fetcher.mock.calls[1]?.[0].url).toBe("https://pypi.org/project/requests/");
		expect(new TextDecoder().decode(result.data)).toContain("Official package page");
	});

	it("downgrades a special-site API failure to the original official page", async () => {
		const fetcher = vi
			.fn<(options: NetworkRequestOptions) => Promise<NetworkResource>>()
			.mockResolvedValueOnce(networkResource("rate limited", { status: 429, statusText: "Too Many Requests" }))
			.mockImplementationOnce(async (options) =>
				networkResource("<main><h1>CVE-2024-3094</h1><p>NVD detail page</p></main>", {
					url: options.url,
					contentType: "text/html",
				}),
			);

		const result = await resolveStructuredWebUrl("https://nvd.nist.gov/vuln/detail/CVE-2024-3094", {
			fetcher,
			cache: new ExternalResourceCache(),
		});

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher.mock.calls[0]?.[0].url).toContain("services.nvd.nist.gov/rest/json/cves/2.0");
		expect(fetcher.mock.calls[1]?.[0].url).toBe("https://nvd.nist.gov/vuln/detail/CVE-2024-3094");
		expect(new TextDecoder().decode(result?.data)).toContain("NVD detail page");
	});

	it("filters the CISA KEV catalog to the requested CVE", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) =>
			networkResource(
				JSON.stringify({
					catalogVersion: "2026.08.10",
					vulnerabilities: [
						{ cveID: "CVE-2024-3094", vendorProject: "XZ", product: "Utils" },
						{ cveID: "CVE-2025-0001", vendorProject: "Other", product: "Other" },
					],
				}),
				{ url: options.url },
			),
		);

		const result = await resolveStructuredWebUrl(
			"https://www.cisa.gov/known-exploited-vulnerabilities-catalog?cve=CVE-2024-3094",
			{ fetcher, cache: new ExternalResourceCache() },
		);
		const text = new TextDecoder().decode(result?.data);

		expect(text).toContain("CVE-2024-3094");
		expect(text).not.toContain("CVE-2025-0001");
	});

	it("projects npm metadata to the latest useful package fields", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) =>
			networkResource(
				JSON.stringify({
					name: "fixture",
					description: "package description",
					"dist-tags": { latest: "2.0.0" },
					versions: {
						"1.0.0": { version: "1.0.0", description: "obsolete-version-marker" },
						"2.0.0": { version: "2.0.0", dependencies: { dep: "^1.0.0" }, license: "MIT" },
					},
					time: { created: "2025-01-01", modified: "2026-08-10", "2.0.0": "2026-08-10" },
				}),
				{ url: options.url },
			),
		);

		const result = await resolveExternalResource("npm://fixture", {
			fetcher,
			cache: new ExternalResourceCache(),
		});
		const text = new TextDecoder().decode(result.data);

		expect(text).toContain('"latestVersion": "2.0.0"');
		expect(text).toContain('"dep": "^1.0.0"');
		expect(text).not.toContain("obsolete-version-marker");
		expect(text.length).toBeLessThan(2_000);
	});

	it("projects repository commits without embedding full patch bodies", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) =>
			networkResource(
				JSON.stringify({
					sha: "abc123",
					html_url: "https://github.com/owner/repo/commit/abc123",
					commit: { message: "fix cache", author: { name: "A" } },
					stats: { additions: 3, deletions: 1 },
					files: [
						{
							filename: "src/cache.ts",
							status: "modified",
							changes: 4,
							patch: "private-large-patch-marker".repeat(1_000),
						},
					],
				}),
				{ url: options.url },
			),
		);

		const result = await resolveExternalResource("github://owner/repo/commit/abc123", {
			fetcher,
			cache: new ExternalResourceCache(),
		});
		const text = new TextDecoder().decode(result.data);

		expect(text).toContain("fix cache");
		expect(text).toContain("src/cache.ts");
		expect(text).not.toContain("private-large-patch-marker");
		expect(text.length).toBeLessThan(2_000);
	});

	it("reads a GitHub file from the official API and returns complete source metadata", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) => {
			expect(options.url).toBe("https://api.github.com/repos/openai/openai-node/contents/src/index.ts?ref=main");
			return networkResource(
				JSON.stringify({
					encoding: "base64",
					content: Buffer.from("export const ok = true;\n").toString("base64"),
				}),
				{ url: options.url },
			);
		});

		const result = await resolveExternalResource("github://openai/openai-node/file/main/src/index.ts", {
			fetcher,
			cache: new ExternalResourceCache(),
		});

		expect(new TextDecoder().decode(result.data)).toContain("export const ok = true;");
		expect(result).toMatchObject({
			sourceAddress: "github://openai/openai-node/file/main/src/index.ts",
			contentType: "text/plain; charset=utf-8",
			cached: false,
			truncated: false,
			untrusted: true,
		});
		expect(result.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("uses a site parser before generic extraction and strips malicious HTML", async () => {
		const fetcher = vi.fn(async (options: NetworkRequestOptions) =>
			networkResource(
				"<html><head><title>Array docs</title></head><body><main><h1>Array</h1><p>Reference text</p><script>steal()</script></main></body></html>",
				{ url: options.url, contentType: "text/html" },
			),
		);

		const result = await resolveStructuredWebUrl(
			"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array",
			{ fetcher, cache: new ExternalResourceCache() },
		);

		expect(result).toBeDefined();
		const text = new TextDecoder().decode(result?.data);
		expect(text).toContain("Reference text");
		expect(text).not.toContain("steal()");
		expect(result?.sourceAddress).toContain("developer.mozilla.org");
	});
});
