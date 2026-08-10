import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	auth,
	type CallToolResult,
	Client,
	type ContentBlock as McpContentBlock,
	SSEClientTransport,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { getAgentDir } from "../../config.ts";
import type { InternalReadResource } from "../../core/tools/unified-read.ts";
import { fingerprintMcpServer } from "./config.ts";
import { McpOAuthProvider } from "./oauth.ts";
import { startOAuthCallbackServer } from "./oauth-callback.ts";
import type {
	McpCachedServer,
	McpCacheFile,
	McpConfiguration,
	McpServerConfig,
	McpServerSnapshot,
	McpToolDescriptor,
} from "./types.ts";
import { isRecord, toToolDescriptor } from "./types.ts";

const CACHE_PATH = join(getAgentDir(), "mcp-cache.json");
const MAX_RESULT_CHARS = 100_000;

interface RuntimeServer {
	name: string;
	config: McpServerConfig;
	fingerprint: string;
	state: McpServerSnapshot["state"];
	client?: Client;
	connecting?: Promise<Client>;
	cache?: McpCachedServer;
	error?: string;
	oauthProvider?: McpOAuthProvider;
}

export interface McpManagerHooks {
	onTools: (server: string, tools: McpToolDescriptor[]) => void;
}

function expandEnvironment(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
		const name = (braced ?? plain) as string;
		return process.env[name] ?? "";
	});
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function clip(value: string): string {
	return value.length <= MAX_RESULT_CHARS
		? value
		: `${value.slice(0, MAX_RESULT_CHARS)}\n\n[结果过长，已截断 ${value.length - MAX_RESULT_CHARS} 个字符]`;
}

function convertContent(block: McpContentBlock): TextContent | ImageContent {
	switch (block.type) {
		case "text":
			return { type: "text", text: clip(block.text) };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
		case "audio":
			return { type: "text", text: `[MCP 音频：${block.mimeType}，${block.data.length} 个 base64 字符]` };
		case "resource_link":
			return { type: "text", text: `[MCP 资源：${block.name}] ${block.uri}` };
		case "resource":
			return "text" in block.resource
				? { type: "text", text: clip(block.resource.text) }
				: {
						type: "text",
						text: `[MCP 二进制资源：${block.resource.mimeType ?? "未知类型"}，${block.resource.blob.length} 个 base64 字符]`,
					};
		default:
			return { type: "text", text: clip(stringify(block)) };
	}
}

export function convertMcpToolResult(result: CallToolResult): Array<TextContent | ImageContent> {
	const content = result.content.map(convertContent);
	if (result.structuredContent !== undefined) {
		content.push({ type: "text", text: clip(`[结构化结果]\n${stringify(result.structuredContent)}`) });
	}
	if (content.length === 0) content.push({ type: "text", text: "MCP 工具执行完成，没有返回内容。" });
	return content;
}

async function loadCache(): Promise<McpCacheFile> {
	try {
		const parsed: unknown = JSON.parse(await readFile(CACHE_PATH, "utf8"));
		if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.servers)) throw new Error("缓存格式无效");
		return parsed as unknown as McpCacheFile;
	} catch {
		return { version: 1, servers: {} };
	}
}

async function saveCache(cache: McpCacheFile): Promise<void> {
	await mkdir(dirname(CACHE_PATH), { recursive: true });
	const temporary = `${CACHE_PATH}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
	await rename(temporary, CACHE_PATH);
}

export class McpManager {
	readonly #hooks: McpManagerHooks;
	readonly #servers = new Map<string, RuntimeServer>();
	#cache: McpCacheFile = { version: 1, servers: {} };

	constructor(hooks: McpManagerHooks) {
		this.#hooks = hooks;
	}

	async initialize(configuration: McpConfiguration): Promise<void> {
		this.#cache = await loadCache();
		for (const [name, config] of configuration.servers) {
			const fingerprint = fingerprintMcpServer(config);
			const cached = this.#cache.servers[name];
			const usableCache = cached?.fingerprint === fingerprint ? cached : undefined;
			this.#servers.set(name, {
				name,
				config,
				fingerprint,
				state: usableCache ? "cached" : "connecting",
				...(usableCache === undefined ? {} : { cache: usableCache }),
			});
			if (usableCache) this.#hooks.onTools(name, usableCache.tools);
		}
	}

	startDiscovery(): void {
		for (const server of this.#servers.values()) void this.refresh(server.name).catch(() => {});
	}

	list(): McpServerSnapshot[] {
		return [...this.#servers.values()].map((server) => this.#snapshot(server));
	}

	async refresh(name: string): Promise<McpServerSnapshot> {
		const server = this.#requireServer(name);
		server.state = "connecting";
		server.error = undefined;
		try {
			const client = await this.#connect(server);
			const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
				client.listTools(undefined, { timeout: server.config.timeoutMs, cacheMode: "refresh" }),
				client.getServerCapabilities()?.resources
					? client.listResources(undefined, { timeout: server.config.timeoutMs, cacheMode: "refresh" })
					: Promise.resolve({ resources: [] }),
				client.getServerCapabilities()?.prompts
					? client.listPrompts(undefined, { timeout: server.config.timeoutMs, cacheMode: "refresh" })
					: Promise.resolve({ prompts: [] }),
			]);
			server.cache = {
				fingerprint: server.fingerprint,
				tools: toolsResult.tools.map(toToolDescriptor),
				resources: resourcesResult.resources.map((resource) => ({
					uri: resource.uri,
					name: resource.name,
					...(resource.description === undefined ? {} : { description: resource.description }),
					...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
				})),
				prompts: promptsResult.prompts.map((prompt) => ({
					name: prompt.name,
					...(prompt.description === undefined ? {} : { description: prompt.description }),
				})),
				updatedAt: new Date().toISOString(),
			};
			server.state = "connected";
			this.#cache.servers[name] = server.cache;
			this.#hooks.onTools(name, server.cache.tools);
			await saveCache(this.#cache);
			return this.#snapshot(server);
		} catch (error) {
			server.state = server.oauthProvider?.authorizationUrl
				? "authorization_required"
				: server.cache
					? "cached"
					: "failed";
			server.error = error instanceof Error ? error.message : String(error);
			throw new Error(`${name}: ${server.error}`);
		}
	}

	async authorize(
		name: string,
		onAuthorizationUrl: (url: URL) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<McpServerSnapshot> {
		const server = this.#requireServer(name);
		if (server.config.type === "stdio" || !server.config.oauth) {
			throw new Error(`${name}: this MCP server does not have OAuth enabled.`);
		}
		const configuredRedirectUrl = new URL(`http://127.0.0.1:${server.config.oauth.callbackPort}/callback`);
		const callback = await startOAuthCallbackServer(configuredRedirectUrl, { signal });
		const provider = this.#oauthProvider(server, callback.redirectUrl);
		provider.setRedirectHandler(onAuthorizationUrl);
		try {
			const initial = await auth(provider, {
				serverUrl: server.config.url,
				...(server.config.oauth.scope === undefined ? {} : { scope: server.config.oauth.scope }),
			});
			if (initial === "REDIRECT") {
				const params = await callback.wait();
				const state = params.get("state");
				if (!state || !(await provider.validateState(state)))
					throw new Error("MCP OAuth callback state did not match.");
				if (params.has("error")) throw new Error("MCP OAuth authorization was rejected.");
				const authorizationCode = params.get("code");
				if (!authorizationCode) throw new Error("MCP OAuth callback did not include an authorization code.");
				await auth(provider, {
					serverUrl: server.config.url,
					authorizationCode,
					...(params.get("iss") === null ? {} : { iss: params.get("iss") ?? undefined }),
					...(server.config.oauth.scope === undefined ? {} : { scope: server.config.oauth.scope }),
				});
			}
			await server.client?.close();
			server.client = undefined;
			server.connecting = undefined;
			return await this.refresh(name);
		} finally {
			provider.setRedirectHandler(undefined);
			await callback.close();
		}
	}

	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Array<TextContent | ImageContent>> {
		const server = this.#requireServer(serverName);
		const client = await this.#connect(server);
		const result = await client.callTool(
			{ name: toolName, arguments: args },
			{
				timeout: server.config.timeoutMs,
				resetTimeoutOnProgress: true,
				...(signal === undefined ? {} : { signal }),
			},
		);
		const content = convertMcpToolResult(result);
		if (result.isError) {
			throw new Error(content.map((item) => (item.type === "text" ? item.text : "[图片]")).join("\n"));
		}
		return content;
	}

	getResources(
		name?: string,
	): Array<{ server: string; uri: string; name: string; description?: string; mimeType?: string }> {
		return [...this.#servers.values()].flatMap((server) =>
			name !== undefined && server.name !== name
				? []
				: (server.cache?.resources ?? []).map((resource) => ({ server: server.name, ...resource })),
		);
	}

	getPrompts(name?: string): Array<{ server: string; name: string; description?: string }> {
		return [...this.#servers.values()].flatMap((server) =>
			name !== undefined && server.name !== name
				? []
				: (server.cache?.prompts ?? []).map((prompt) => ({ server: server.name, ...prompt })),
		);
	}

	async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<InternalReadResource> {
		const server = this.#requireServer(serverName);
		const client = await this.#connect(server);
		const result = await client.readResource(
			{ uri },
			{ timeout: server.config.timeoutMs, ...(signal === undefined ? {} : { signal }) },
		);
		const resource = result.contents[0];
		if (!resource) throw new Error("MCP 资源没有内容。");
		return "text" in resource
			? { data: resource.text, mimeType: resource.mimeType, label: uri, external: true }
			: { data: Buffer.from(resource.blob, "base64"), mimeType: resource.mimeType, label: uri, external: true };
	}

	async getPrompt(serverName: string, name: string, args: Record<string, string> = {}): Promise<string> {
		const server = this.#requireServer(serverName);
		const client = await this.#connect(server);
		const result = await client.getPrompt({ name, arguments: args }, { timeout: server.config.timeoutMs });
		return result.messages
			.map((message) =>
				message.content.type === "text"
					? `[${message.role}] ${message.content.text}`
					: `[${message.role}] [${message.content.type}]`,
			)
			.join("\n\n");
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.#servers.values()].map((server) => server.client?.close()));
		this.#servers.clear();
	}

	async #connect(server: RuntimeServer): Promise<Client> {
		if (server.client) return server.client;
		if (server.connecting) return server.connecting;
		server.connecting = this.#createClient(server);
		try {
			server.client = await server.connecting;
			server.state = "connected";
			return server.client;
		} finally {
			server.connecting = undefined;
		}
	}

	async #createClient(server: RuntimeServer): Promise<Client> {
		const client = new Client(
			{ name: "pi-go", version: "0.84.1" },
			{ enforceStrictCapabilities: false, listMaxPages: 32 },
		);
		const authProvider =
			server.config.type === "stdio" || !server.config.oauth
				? undefined
				: this.#oauthProvider(server, new URL(`http://127.0.0.1:${server.config.oauth.callbackPort}/callback`));
		const transport =
			server.config.type === "stdio"
				? new StdioClientTransport({
						command: server.config.command,
						args: server.config.args,
						env: {
							...getDefaultEnvironment(),
							...Object.fromEntries(
								Object.entries(server.config.env).map(([key, value]) => [key, expandEnvironment(value)]),
							),
						},
						...(server.config.cwd === undefined ? {} : { cwd: server.config.cwd }),
						stderr: "pipe",
					})
				: server.config.type === "sse"
					? new SSEClientTransport(new URL(server.config.url), {
							requestInit: { headers: server.config.headers },
							...(authProvider === undefined ? {} : { authProvider }),
						})
					: new StreamableHTTPClientTransport(new URL(server.config.url), {
							requestInit: { headers: server.config.headers },
							...(authProvider === undefined ? {} : { authProvider }),
						});
		await client.connect(transport, { timeout: server.config.timeoutMs });
		return client;
	}

	#oauthProvider(server: RuntimeServer, redirectUrl: URL): McpOAuthProvider {
		if (server.config.type === "stdio" || !server.config.oauth) throw new Error("OAuth is not configured.");
		server.oauthProvider ??= new McpOAuthProvider({
			serverName: server.name,
			serverUrl: server.config.url,
			redirectUrl,
			oauth: server.config.oauth,
		});
		return server.oauthProvider;
	}

	#requireServer(name: string): RuntimeServer {
		const server = this.#servers.get(name);
		if (!server) throw new Error(`没有名为 ${name} 的 MCP 服务器。`);
		return server;
	}

	#snapshot(server: RuntimeServer): McpServerSnapshot {
		return {
			name: server.name,
			state: server.state,
			transport: server.config.type,
			toolCount: server.cache?.tools.length ?? 0,
			resourceCount: server.cache?.resources.length ?? 0,
			promptCount: server.cache?.prompts.length ?? 0,
			...(server.cache?.updatedAt === undefined ? {} : { updatedAt: server.cache.updatedAt }),
			...(server.error === undefined ? {} : { error: server.error }),
		};
	}
}
