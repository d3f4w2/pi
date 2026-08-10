import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
	type Agent,
	AgentSideConnection,
	type CancelNotification,
	type ClientCapabilities,
	type ContentBlock,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type McpServer,
	type NewSessionRequest,
	type NewSessionResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionNotification,
	type StopReason,
} from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { waitForRawStdoutBackpressure, writeRawStdout } from "../../core/output-guard.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { clearSessionMcpConfiguration, setSessionMcpConfiguration } from "../../extensions/mcp/session-config.ts";
import type { McpServerConfig } from "../../extensions/mcp/types.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { createAcpToolDefinitionOverrides } from "./client-operations.ts";

export { createAcpToolDefinitionOverrides } from "./client-operations.ts";

export function mapAcpToolKind(name: string): "read" | "edit" | "search" | "execute" | "fetch" | "other" {
	if (["read", "ls"].includes(name)) return "read";
	if (["grep", "find", "code_search", "ast_grep", "lsp"].includes(name)) return "search";
	if (["edit", "write", "ast_edit"].includes(name)) return "edit";
	if (["web_search", "web_fetch", "browser"].includes(name)) return "fetch";
	if (["bash", "process", "debug", "git"].includes(name)) return "execute";
	return "other";
}

function permissionKind(
	option: string,
	index: number,
): "allow_once" | "allow_always" | "reject_once" | "reject_always" {
	if (/始终允许|always allow/i.test(option)) return "allow_always";
	if (/始终禁止|always (?:deny|reject)/i.test(option)) return "reject_always";
	if (/拒绝|禁止|deny|reject/i.test(option)) return "reject_once";
	return index === 1 ? "allow_always" : "allow_once";
}

export function convertAcpPromptContent(blocks: ContentBlock[]): { text: string; images: ImageContent[] } {
	const text: string[] = [];
	const images: ImageContent[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				text.push(block.text);
				break;
			case "image":
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link":
				text.push(`[资源：${block.name}] ${block.uri}`);
				break;
			case "resource":
				text.push(
					"text" in block.resource
						? `[资源：${block.resource.uri}]\n${block.resource.text}`
						: `[二进制资源：${block.resource.uri}，${block.resource.mimeType ?? "未知类型"}]`,
				);
				break;
			case "audio":
				text.push(`[音频：${block.mimeType}，当前模型输入不支持直接转发]`);
				break;
		}
	}
	return { text: text.join("\n\n"), images };
}

function stopReason(message: AssistantMessage | undefined): StopReason {
	if (!message) return "end_turn";
	if (message.stopReason === "aborted") return "cancelled";
	if (message.stopReason === "length") return "max_tokens";
	if (message.stopReason === "error") return "refusal";
	return "end_turn";
}

export function convertAcpMcpServers(servers: McpServer[]): ReadonlyMap<string, McpServerConfig> {
	const configured = new Map<string, McpServerConfig>();
	for (const server of servers) {
		const name = server.name
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		if (!name) throw new Error(`MCP 服务器名无效：${server.name}`);
		if (configured.has(name)) throw new Error(`MCP 服务器名冲突：${server.name}`);
		if ("serverId" in server) throw new Error("暂不支持 ACP 通道内嵌 MCP；请使用 stdio、HTTP 或 SSE。");
		if ("command" in server) {
			configured.set(name, {
				type: "stdio",
				command: server.command,
				args: server.args,
				env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
				timeoutMs: 15_000,
			});
		} else {
			configured.set(name, {
				type: server.type,
				url: server.url,
				headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
				timeoutMs: 15_000,
			});
		}
	}
	return configured;
}

function configureSessionMcp(cwd: string, servers: McpServer[]): void {
	setSessionMcpConfiguration(cwd, convertAcpMcpServers(servers));
}

function messageText(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.flatMap((item) => (item.type === "text" ? [item.text] : item.type === "thinking" ? [item.thinking] : []))
			.join("\n");
	}
	return "";
}

class AcpSessionBridge {
	readonly #runtime: AgentSessionRuntime;
	readonly #connection: AgentSideConnection;
	#session: AgentSession;
	#unsubscribe?: () => void;
	#updates: Promise<void> = Promise.resolve();
	#messageId?: string;
	#lastAssistant?: AssistantMessage;
	#clientCapabilities?: ClientCapabilities;

	constructor(runtime: AgentSessionRuntime, connection: AgentSideConnection) {
		this.#runtime = runtime;
		this.#connection = connection;
		this.#session = runtime.session;
	}

	get lastAssistant(): AssistantMessage | undefined {
		return this.#lastAssistant;
	}

	resetTurn(): void {
		this.#lastAssistant = undefined;
		this.#messageId = undefined;
	}

	async bindSession(): Promise<void> {
		this.#session = this.#runtime.session;
		await this.#session.bindExtensions({
			uiContext: this.#createUiContext(),
			mode: "acp",
			commandContextActions: {
				waitForIdle: () => this.#session.waitForIdle(),
				newSession: async (options) => this.#runtime.newSession(options),
				fork: async (entryId, options) => {
					const result = await this.#runtime.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.#session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: async (path, options) => this.#runtime.switchSession(path, options),
				reload: async () => this.#session.reload(),
			},
			onError: (error) => process.stderr.write(`ACP extension error: ${error.error}\n`),
		});
		this.#applyClientToolRouting();
		this.#unsubscribe?.();
		this.#unsubscribe = this.#session.subscribe((event) => this.#onEvent(event));
	}

	setClientCapabilities(capabilities: ClientCapabilities | undefined): void {
		this.#clientCapabilities = capabilities;
		this.#applyClientToolRouting();
	}

	async replayHistory(): Promise<void> {
		for (const message of this.#session.messages) {
			const text = messageText(message);
			if (!text) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;
			this.#queue({
				sessionId: this.#session.sessionId,
				update: {
					sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
					content: { type: "text", text },
					messageId: randomUUID(),
				},
			});
		}
		await this.flush();
	}

	async flush(): Promise<void> {
		await this.#updates;
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	#queue(notification: SessionNotification): void {
		this.#updates = this.#updates
			.catch(() => undefined)
			.then(() => this.#connection.sessionUpdate(notification))
			.catch((error) => {
				process.stderr.write(`ACP update failed: ${String(error)}\n`);
			});
	}

	#onEvent(event: AgentSessionEvent): void {
		const sessionId = this.#session.sessionId;
		if (event.type === "message_start" && event.message.role === "assistant") this.#messageId = randomUUID();
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" || update.type === "thinking_delta") {
				this.#messageId ??= randomUUID();
				this.#queue({
					sessionId,
					update: {
						sessionUpdate: update.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk",
						content: { type: "text", text: update.delta },
						messageId: this.#messageId,
					},
				});
			}
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.#lastAssistant = event.message;
			const usage = this.#session.getContextUsage();
			if (usage?.tokens !== null && usage !== undefined) {
				this.#queue({
					sessionId,
					update: { sessionUpdate: "usage_update", used: usage.tokens, size: usage.contextWindow },
				});
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#queue({
				sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: event.toolCallId,
					title: event.toolName,
					name: event.toolName,
					kind: mapAcpToolKind(event.toolName),
					status: "in_progress",
					rawInput: event.args,
				},
			});
			return;
		}
		if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			this.#queue({
				sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: event.type === "tool_execution_update" ? "in_progress" : event.isError ? "failed" : "completed",
					rawOutput: event.type === "tool_execution_update" ? event.partialResult : event.result,
				},
			});
		}
	}

	#createUiContext(): ExtensionUIContext {
		const select = async (
			title: string,
			options: string[],
			dialog?: ExtensionUIDialogOptions,
		): Promise<string | undefined> => {
			if (dialog?.signal?.aborted || options.length === 0) return undefined;
			const permissionOptions = options.map((option, index) => ({
				optionId: String(index),
				name: option,
				kind: permissionKind(option, index),
			}));
			try {
				const response = await this.#connection.requestPermission({
					sessionId: this.#session.sessionId,
					toolCall: { toolCallId: randomUUID(), title },
					options: permissionOptions,
				});
				if (response.outcome.outcome !== "selected") return undefined;
				const index = Number.parseInt(response.outcome.optionId, 10);
				return options[index];
			} catch {
				return undefined;
			}
		};
		return {
			select,
			confirm: async (title, message, options) =>
				(await select(`${title}\n${message}`, ["允许本次", "拒绝本次"], options)) === "允许本次",
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: (_options?: WorkingIndicatorOptions) => {},
			setHiddenThinkingLabel: () => {},
			setWidget: (_key: string, _content: unknown, _options?: ExtensionWidgetOptions) => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: (_theme: string | Theme) => ({ success: false, error: "ACP 模式不支持切换终端主题" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	#applyClientToolRouting(): void {
		this.#session.setBaseToolDefinitionOverrides(
			createAcpToolDefinitionOverrides(
				this.#session.sessionManager.getCwd(),
				this.#session.sessionId,
				this.#clientCapabilities,
				this.#connection,
			),
		);
	}
}

class PiGoAcpAgent implements Agent {
	readonly #runtime: AgentSessionRuntime;
	readonly #bridge: AcpSessionBridge;
	readonly #ready: Promise<void>;

	constructor(runtime: AgentSessionRuntime, connection: AgentSideConnection) {
		this.#runtime = runtime;
		this.#bridge = new AcpSessionBridge(runtime, connection);
		this.#runtime.setRebindSession(async () => this.#bridge.bindSession());
		this.#ready = this.#bridge.bindSession();
	}

	async start(): Promise<void> {
		await this.#ready;
	}

	initialize(params: InitializeRequest): InitializeResponse {
		this.#bridge.setClientCapabilities(params.clientCapabilities);
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true },
				mcpCapabilities: { http: true, sse: true },
				sessionCapabilities: { list: {}, resume: {} },
			},
			agentInfo: { name: "pi-go", version: "0.84.1" },
		};
	}

	authenticate(): void {
		throw new Error("pi-go ACP 不需要单独认证；请在 pi-go 中配置模型凭据。");
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		await this.#ready;
		this.#assertCwd(params.cwd);
		configureSessionMcp(params.cwd, params.mcpServers);
		const result = await this.#runtime.newSession();
		if (result.cancelled) throw new Error("新会话被扩展取消。");
		return { sessionId: this.#runtime.session.sessionId };
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		await this.#ready;
		configureSessionMcp(params.cwd, params.mcpServers);
		await this.#switchSession(params.sessionId, params.cwd);
		await this.#bridge.replayHistory();
		return {};
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		await this.#ready;
		const cwd = params.cwd ?? this.#runtime.cwd;
		const sessions = await SessionManager.list(cwd, this.#runtime.session.sessionManager.getSessionDir());
		return {
			sessions: sessions.map((session) => ({
				sessionId: session.id,
				cwd: session.cwd || cwd,
				...(session.name === undefined ? {} : { title: session.name }),
				updatedAt: session.modified.toISOString(),
			})),
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		await this.#ready;
		configureSessionMcp(params.cwd, params.mcpServers ?? []);
		await this.#switchSession(params.sessionId, params.cwd);
		return {};
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		await this.#ready;
		this.#assertSession(params.sessionId);
		const content = convertAcpPromptContent(params.prompt);
		this.#bridge.resetTurn();
		await this.#runtime.session.prompt(content.text, {
			images: content.images,
			source: "rpc",
		});
		await this.#bridge.flush();
		const message = this.#bridge.lastAssistant;
		return {
			stopReason: stopReason(message),
			...(message?.usage === undefined
				? {}
				: {
						usage: {
							totalTokens:
								message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite,
							inputTokens: message.usage.input,
							outputTokens: message.usage.output,
							thoughtTokens: 0,
						},
					}),
		};
	}

	async cancel(params: CancelNotification): Promise<void> {
		await this.#ready;
		this.#assertSession(params.sessionId);
		await this.#runtime.session.abort();
	}

	dispose(): void {
		this.#bridge.dispose();
		this.#runtime.setRebindSession(undefined);
		clearSessionMcpConfiguration(this.#runtime.cwd);
	}

	async #switchSession(sessionId: string, cwd: string): Promise<void> {
		this.#assertCwd(cwd);
		if (sessionId === this.#runtime.session.sessionId) return;
		const sessions = await SessionManager.list(cwd, this.#runtime.session.sessionManager.getSessionDir());
		const target = sessions.find((session) => session.id === sessionId);
		if (!target) throw new Error(`找不到会话 ${sessionId}。`);
		const result = await this.#runtime.switchSession(target.path, { cwdOverride: cwd });
		if (result.cancelled) throw new Error("切换会话被扩展取消。");
	}

	#assertSession(sessionId: string): void {
		if (sessionId !== this.#runtime.session.sessionId) throw new Error(`会话 ${sessionId} 当前未激活。`);
	}

	#assertCwd(cwd: string): void {
		if (cwd !== this.#runtime.cwd) throw new Error(`ACP 当前工作区是 ${this.#runtime.cwd}，不能切换到 ${cwd}。`);
	}
}

export async function runAcpMode(runtime: AgentSessionRuntime): Promise<void> {
	const output = new WritableStream<Uint8Array>({
		async write(chunk) {
			writeRawStdout(Buffer.from(chunk).toString("utf8"));
			await waitForRawStdoutBackpressure();
		},
	});
	const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	let agent: PiGoAcpAgent | undefined;
	new AgentSideConnection(
		(connection) => {
			agent = new PiGoAcpAgent(runtime, connection);
			void agent.start().catch((error) => process.stderr.write(`ACP startup failed: ${String(error)}\n`));
			return agent;
		},
		ndJsonStream(output, input),
	);
	await new Promise<void>((resolve) => {
		if (process.stdin.readableEnded) resolve();
		else process.stdin.once("end", resolve);
	});
	agent?.dispose();
	await runtime.dispose();
}
