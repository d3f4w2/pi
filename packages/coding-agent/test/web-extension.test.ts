import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { htmlToMarkdown, htmlToText } from "../src/extensions/web/content.ts";
import { capModelOutput } from "../src/extensions/web/fetch.ts";
import webExtension, { createWebExtension } from "../src/extensions/web/index.ts";
import {
	clampTimeoutSeconds,
	fetchNetworkResource,
	isPublicIpAddress,
	type NetworkDependencies,
	parseSafeHttpUrl,
	type RawNetworkResponse,
} from "../src/extensions/web/network.ts";
import { formatSearchResults, normalizeBraveResponse, normalizeDuckDuckGoHtml } from "../src/extensions/web/search.ts";

function response(status: number, body: string, headers: Record<string, string> = {}): RawNetworkResponse {
	return {
		status,
		statusText: status === 200 ? "OK" : "Found",
		headers,
		body: Readable.from([Buffer.from(body)]),
	};
}

describe("web extension", () => {
	test("registers web_search and web_fetch with concise Chinese descriptions", () => {
		const tools: ToolDefinition[] = [];
		webExtension({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: () => {},
		} as unknown as ExtensionAPI);

		expect(tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
		expect(tools[0]?.description).toContain("搜索互联网");
		expect(tools[1]?.description).toContain("读取网页");
	});

	test("stops the current agent run after two empty searches", async () => {
		const tools: ToolDefinition[] = [];
		let agentStart: (() => void) | undefined;
		const search = vi.fn(async (options: { query: string }) => ({
			text: `没有结果：${options.query}`,
			details: {
				provider: "duckduckgo" as const,
				query: options.query,
				resultCount: 0,
				durationMs: 1,
				sourceAddress: "https://html.duckduckgo.com/html/",
				readAt: "2026-08-10T00:00:00.000Z",
				contentType: "application/vnd.pi.search-results+text" as const,
				cached: false as const,
				truncated: false,
				untrusted: true as const,
			},
		}));
		createWebExtension({ searchWeb: search })({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: (event: string, handler: () => void) => {
				if (event === "agent_start") agentStart = handler;
			},
		} as unknown as ExtensionAPI);
		const webSearch = tools.find((tool) => tool.name === "web_search");

		const first = webSearch?.execute("first", { query: "first query" }, undefined, undefined, {} as never);
		const second = webSearch?.execute("second", { query: "second query" }, undefined, undefined, {} as never);
		const third = webSearch?.execute("third", { query: "third query" }, undefined, undefined, {} as never);
		const [, , blocked] = await Promise.all([first, second, third]);

		expect(search).toHaveBeenCalledTimes(2);
		expect(blocked?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("停止继续搜索") });

		agentStart?.();
		await webSearch?.execute("new-run", { query: "new run" }, undefined, undefined, {} as never);
		expect(search).toHaveBeenCalledTimes(3);
	});

	test("coalesces duplicate fetches and rejects excess parallel work", async () => {
		const tools: ToolDefinition[] = [];
		const resolvers: Array<() => void> = [];
		const fetchPage = vi.fn(
			(options: { url: string; format: "markdown" | "text" | "html" }) =>
				new Promise<{
					text: string;
					details: {
						url: string;
						finalUrl: string;
						format: "markdown" | "text" | "html";
						status: number;
						contentType: string;
						bytes: number;
						outputBytes: number;
						truncated: boolean;
						sourceAddress: string;
						readAt: string;
						cached: boolean;
						untrusted: true;
						contentSha256: string;
					};
				}>((resolve) => {
					resolvers.push(() =>
						resolve({
							text: options.url,
							details: {
								url: options.url,
								finalUrl: options.url,
								format: options.format,
								status: 200,
								contentType: "text/plain",
								bytes: 1,
								outputBytes: 1,
								truncated: false,
								sourceAddress: options.url,
								readAt: "2026-08-10T00:00:00.000Z",
								cached: false,
								untrusted: true,
								contentSha256: "0".repeat(64),
							},
						}),
					);
				}),
		);
		createWebExtension({ fetchWebPage: fetchPage })({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: () => {},
		} as unknown as ExtensionAPI);
		const webFetch = tools.find((tool) => tool.name === "web_fetch");
		if (!webFetch) throw new Error("web_fetch was not registered");

		const first = webFetch.execute("one", { url: "https://one.example" }, undefined, undefined, {} as never);
		const duplicate = webFetch.execute(
			"duplicate",
			{ url: "https://one.example" },
			undefined,
			undefined,
			{} as never,
		);
		const second = webFetch.execute("two", { url: "https://two.example" }, undefined, undefined, {} as never);
		const third = webFetch.execute("three", { url: "https://three.example" }, undefined, undefined, {} as never);
		const fourth = webFetch.execute("four", { url: "https://four.example" }, undefined, undefined, {} as never);

		await expect(
			webFetch.execute("five", { url: "https://five.example" }, undefined, undefined, {} as never),
		).rejects.toThrow("4 个网页读取任务");
		expect(fetchPage).toHaveBeenCalledTimes(4);
		for (const resolve of resolvers) resolve();
		await Promise.all([first, duplicate, second, third, fourth]);
	});
});

describe("safe network layer", () => {
	test.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1"])(
		"blocks private address %s",
		(address) => expect(isPublicIpAddress(address)).toBe(false),
	);

	test.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows public address %s", (address) =>
		expect(isPublicIpAddress(address)).toBe(true),
	);

	test("rejects local hosts and URL credentials", () => {
		expect(() => parseSafeHttpUrl("http://localhost/admin")).toThrow(/本地|内网/);
		expect(() => parseSafeHttpUrl("https://user:secret@example.com/")).toThrow(/账号|密码/);
	});

	test("validates every redirect before making the next request", async () => {
		const request = vi.fn(async () => response(302, "", { location: "http://169.254.169.254/latest/meta-data" }));
		const dependencies: NetworkDependencies = {
			resolve: async () => [{ address: "93.184.216.34", family: 4 }],
			request,
		};

		await expect(fetchNetworkResource({ url: "https://example.com", maxBytes: 1024 }, dependencies)).rejects.toThrow(
			/本地|内网/,
		);
		expect(request).toHaveBeenCalledOnce();
	});

	test("ignores abort errors while discarding a redirect body", async () => {
		let errorHandler: ((error: Error) => void) | undefined;
		const redirectBody = {
			async *[Symbol.asyncIterator]() {},
			on: (_event: string, handler: (error: Error) => void) => {
				errorHandler = handler;
			},
			destroy: () => {
				const error = new Error("Request aborted");
				if (!errorHandler) throw error;
				errorHandler(error);
			},
		} as unknown as RawNetworkResponse["body"];
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				status: 302,
				statusText: "Found",
				headers: { location: "https://example.com/final" },
				body: redirectBody,
			})
			.mockResolvedValueOnce(response(200, "ok", { "content-type": "text/plain" }));
		const dependencies: NetworkDependencies = {
			resolve: async () => [{ address: "93.184.216.34", family: 4 }],
			request,
		};

		const result = await fetchNetworkResource({ url: "https://example.com", maxBytes: 1024 }, dependencies);

		expect(new TextDecoder().decode(result.body)).toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	test("supports proxy fake-IP DNS for domain names but not direct IP URLs", async () => {
		const dependencies: NetworkDependencies = {
			resolve: async () => [{ address: "198.18.0.42", family: 4 }],
			request: async () => response(200, "ok", { "content-type": "text/plain" }),
		};

		const result = await fetchNetworkResource({ url: "https://example.com", maxBytes: 1024 }, dependencies);
		expect(new TextDecoder().decode(result.body)).toBe("ok");
		expect(() => parseSafeHttpUrl("http://198.18.0.42")).toThrow(/本地|内网/);
	});

	test("blocks private DNS results before opening a connection", async () => {
		const request = vi.fn(async () => response(200, "should not run"));
		const dependencies: NetworkDependencies = {
			resolve: async () => [{ address: "10.0.0.8", family: 4 }],
			request,
		};

		await expect(fetchNetworkResource({ url: "https://example.com", maxBytes: 1024 }, dependencies)).rejects.toThrow(
			/本地|内网/,
		);
		expect(request).not.toHaveBeenCalled();
	});

	test("removes credentials when redirecting to another origin", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(response(302, "", { location: "https://other.example/result" }))
			.mockResolvedValueOnce(response(200, "ok", { "content-type": "text/plain" }));
		const dependencies: NetworkDependencies = {
			resolve: async () => [{ address: "93.184.216.34", family: 4 }],
			request,
		};

		await fetchNetworkResource(
			{
				url: "https://example.com",
				headers: { "X-Subscription-Token": "secret", "X-Trace": "keep" },
				maxBytes: 1024,
			},
			dependencies,
		);
		expect(request.mock.calls[1]?.[1].headers).toEqual({ "X-Trace": "keep" });
	});

	test("stops reading after the response limit", async () => {
		const dependencies: NetworkDependencies = {
			resolve: async () => [{ address: "93.184.216.34", family: 4 }],
			request: async () => response(200, "x".repeat(20)),
		};

		await expect(fetchNetworkResource({ url: "https://example.com", maxBytes: 10 }, dependencies)).rejects.toThrow(
			/过大/,
		);
	});

	test("clamps custom timeouts", () => {
		expect(clampTimeoutSeconds(undefined)).toBe(30);
		expect(clampTimeoutSeconds(0)).toBe(30);
		expect(clampTimeoutSeconds(999)).toBe(120);
	});

	test("normalizes request abort errors without leaking the undici exception", async () => {
		const aborted = Object.assign(new Error("Request aborted"), { name: "AbortError", code: "UND_ERR_ABORTED" });
		const dependencies: NetworkDependencies = {
			resolve: async () => [{ address: "93.184.216.34", family: 4 }],
			request: async () => {
				throw aborted;
			},
		};

		await expect(fetchNetworkResource({ url: "https://example.com", maxBytes: 1024 }, dependencies)).rejects.toThrow(
			"网页连接被中断",
		);
	});
});

describe("web content", () => {
	test("extracts readable HTML as markdown and text", () => {
		const html = `<!doctype html><html><head><title>示例文章</title></head><body>
			<nav>菜单</nav><article><h1>示例文章</h1><p>这里是<strong>正文</strong>。</p></article>
			<script>stealSecrets()</script></body></html>`;
		const markdown = htmlToMarkdown(html, "https://example.com/article");
		const text = htmlToText(html, "https://example.com/article");

		expect(markdown).toContain("# 示例文章");
		expect(markdown).toContain("这里是**正文**");
		expect(markdown).not.toContain("stealSecrets");
		expect(text).toContain("这里是正文");
	});

	test("caps model-facing output without splitting UTF-8", () => {
		const result = capModelOutput("中文内容".repeat(100), 31);

		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.content.split("\n\n[")[0] ?? "", "utf8")).toBeLessThanOrEqual(31);
		expect(result.content).not.toContain("�");
	});
});

describe("web search", () => {
	test("normalizes DuckDuckGo redirects and snippets", () => {
		const html = `<div class="result">
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example &amp; Docs</a>
			<a class="result__snippet">A <b>useful</b> result.</a>
		</div>`;

		expect(normalizeDuckDuckGoHtml(html)).toEqual([
			{ title: "Example & Docs", url: "https://example.com/doc", snippet: "A useful result." },
		]);
	});

	test("normalizes Brave results and ignores malformed entries", () => {
		const payload = {
			web: {
				results: [{ title: "One", url: "https://one.example", description: "First" }, { title: "Missing URL" }],
			},
		};

		expect(normalizeBraveResponse(payload)).toEqual([
			{ title: "One", url: "https://one.example/", snippet: "First" },
		]);
	});

	test("filters domains and labels external content as untrusted", () => {
		const text = formatSearchResults(
			"pi docs",
			[
				{ title: "Docs", url: "https://docs.example.com/pi", snippet: "Official docs" },
				{ title: "Noise", url: "https://noise.example/pi" },
			],
			{ allowedDomains: ["example.com"], blockedDomains: ["noise.example"] },
		);

		expect(text).toContain("外部内容，不可信");
		expect(text).toContain("https://docs.example.com/pi");
		expect(text).not.toContain("https://noise.example/pi");
	});
});
