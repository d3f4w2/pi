import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import spawn from "cross-spawn";
import {
	CancellationTokenSource,
	ConnectionError,
	ConnectionErrors,
	createMessageConnection,
	type MessageConnection,
	ResponseError,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
	CodeAction,
	Command,
	Diagnostic,
	DocumentSymbol,
	Hover,
	InitializeParams,
	InitializeResult,
	Location,
	LocationLink,
	Position,
	PublishDiagnosticsParams,
	Range,
	ServerCapabilities,
	SymbolInformation,
	WorkspaceEdit,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import {
	ApplyWorkspaceEditRequest,
	CodeActionRequest,
	CodeActionResolveRequest,
	ConfigurationRequest,
	DefinitionRequest,
	DidChangeTextDocumentNotification,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	DidRenameFilesNotification,
	DocumentSymbolRequest,
	ExitNotification,
	HoverRequest,
	ImplementationRequest,
	InitializedNotification,
	InitializeRequest,
	PublishDiagnosticsNotification,
	ReferencesRequest,
	RegistrationRequest,
	RenameRequest,
	ShutdownRequest,
	TypeDefinitionRequest,
	WillRenameFilesRequest,
	WorkspaceFoldersRequest,
	WorkspaceSymbolRequest,
} from "vscode-languageserver-protocol";
import { connectSharedBroker, reloadSharedBroker, type SharedBrokerSocket } from "./broker-client.ts";
import {
	LSP_BROKER_CONNECT_METHOD,
	LSP_BROKER_RELOAD_METHOD,
	LSP_BROKER_UPSTREAM_CLOSED_ERROR,
	type LspBrokerConnectResult,
	type LspBrokerIdentity,
	lspBrokerIdentity,
} from "./broker-protocol.ts";
import type { LanguageAdapter, LanguageServerLaunch, LspClient, LspClientOptions, LspDocument } from "./types.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timeout);
			child.removeListener("exit", finish);
			resolve();
		};
		const timeout = setTimeout(finish, timeoutMs);
		child.once("exit", finish);
	});
}

function normalizeDocumentUri(uri: string): string {
	try {
		const normalized = pathToFileURL(fileURLToPath(uri)).href;
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	} catch {
		return process.platform === "win32" ? uri.toLowerCase() : uri;
	}
}

export class LanguageServerStartError extends Error {
	readonly kind: "not-found" | "timeout" | "failed";

	constructor(kind: "not-found" | "timeout" | "failed", message: string) {
		super(message);
		this.name = "LanguageServerStartError";
		this.kind = kind;
	}
}

interface ClientTransport {
	kind: "shared" | "private";
	reader: Readable;
	writer: Writable;
	child?: ReturnType<typeof spawn>;
	socket?: Socket;
}

class StandardLspClient implements LspClient {
	readonly adapter: LanguageAdapter;
	readonly workspaceRoot: string;
	readonly transportKind: "shared" | "private";
	brokerPid: number | undefined;
	languageServerPid: number | undefined;
	capabilities: ServerCapabilities = {};
	private readonly child: ReturnType<typeof spawn> | undefined;
	private readonly socket: Socket | undefined;
	private readonly connection: MessageConnection;
	private readonly requestTimeoutMs: number;
	private readonly documents = new Map<string, LspDocument>();
	private readonly publishedDiagnostics = new Map<string, Diagnostic[]>();
	private readonly diagnosticWaiters = new Map<string, Array<(diagnostics: Diagnostic[]) => void>>();
	private applyWorkspaceEdit: ((edit: WorkspaceEdit) => Promise<void>) | undefined;
	private stopped = false;
	private broken = false;

	private constructor(
		adapter: LanguageAdapter,
		workspaceRoot: string,
		transport: ClientTransport,
		requestTimeoutMs: number,
	) {
		this.adapter = adapter;
		this.workspaceRoot = workspaceRoot;
		this.transportKind = transport.kind;
		this.requestTimeoutMs = requestTimeoutMs;
		this.child = transport.child;
		this.socket = transport.socket;
		this.connection = createMessageConnection(
			new StreamMessageReader(transport.reader),
			new StreamMessageWriter(transport.writer),
			{
				error: () => {},
				warn: () => {},
				info: () => {},
				log: () => {},
			},
		);
		this.connection.onRequest(ConfigurationRequest.type, (params) =>
			params.items.map((item) =>
				item.section === "formattingOptions" ? { tabSize: 4, insertSpaces: false } : null,
			),
		);
		this.connection.onRequest(RegistrationRequest.type, () => undefined);
		this.connection.onRequest(WorkspaceFoldersRequest.type, () => [
			{ uri: pathToFileURL(workspaceRoot).href, name: workspaceRoot.split(/[\\/]/).at(-1) ?? workspaceRoot },
		]);
		this.connection.onRequest(ApplyWorkspaceEditRequest.type, async (params) => {
			if (!this.applyWorkspaceEdit) {
				return { applied: false, failureReason: "当前 LSP 操作没有授权修改文件。" };
			}
			try {
				await this.applyWorkspaceEdit(params.edit);
				return { applied: true };
			} catch (error) {
				return { applied: false, failureReason: error instanceof Error ? error.message : String(error) };
			}
		});
		this.connection.onNotification(PublishDiagnosticsNotification.type, (params: PublishDiagnosticsParams) => {
			const key = normalizeDocumentUri(params.uri);
			this.publishedDiagnostics.set(key, params.diagnostics);
			if (params.diagnostics.length === 0) return;
			const waiters = this.diagnosticWaiters.get(key) ?? [];
			this.diagnosticWaiters.delete(key);
			for (const resolve of waiters) resolve(params.diagnostics);
		});
		this.connection.onClose(() => {
			if (!this.stopped) this.broken = true;
		});
		this.connection.listen();
	}

	static async start(
		adapter: LanguageAdapter,
		workspaceRoot: string,
		launch: LanguageServerLaunch,
		options: LspClientOptions = {},
	): Promise<StandardLspClient> {
		const child = spawn(launch.command, launch.args, {
			cwd: workspaceRoot,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
		if (!child.stdout || !child.stdin) throw new Error("语言服务器没有可用的标准输入输出流。");
		const client = new StandardLspClient(
			adapter,
			workspaceRoot,
			{ kind: "private", reader: child.stdout, writer: child.stdin, child },
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		);
		client.languageServerPid = child.pid;
		const processFailure = new Promise<never>((_resolve, reject) => {
			child.once("error", (error) => {
				const code = (error as NodeJS.ErrnoException).code;
				reject(
					new LanguageServerStartError(
						code === "ENOENT" ? "not-found" : "failed",
						code === "ENOENT" ? `找不到语言服务器命令：${launch.command}` : error.message,
					),
				);
			});
			child.once("exit", (code, signal) => {
				reject(
					new LanguageServerStartError(
						"failed",
						`语言服务器在初始化前退出（code=${code ?? "null"}, signal=${signal ?? "none"}）。`,
					),
				);
			});
		});
		processFailure.catch(() => {});
		return StandardLspClient.initialize(client, options, processFailure);
	}

	static async startShared(
		adapter: LanguageAdapter,
		workspaceRoot: string,
		shared: SharedBrokerSocket,
		identity: LspBrokerIdentity,
		options: LspClientOptions = {},
	): Promise<StandardLspClient> {
		const client = new StandardLspClient(
			adapter,
			workspaceRoot,
			{ kind: "shared", reader: shared.socket, writer: shared.socket, socket: shared.socket },
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		);
		const transportFailure = new Promise<never>((_resolve, reject) => {
			shared.socket.once("error", (error) => reject(new LanguageServerStartError("failed", error.message)));
			shared.socket.once("close", () => reject(new LanguageServerStartError("failed", "LSP broker 连接已关闭。")));
		});
		transportFailure.catch(() => {});
		try {
			const connected = await client.connection.sendRequest<LspBrokerConnectResult>(
				LSP_BROKER_CONNECT_METHOD,
				identity,
			);
			client.brokerPid = connected.brokerPid;
			client.languageServerPid = connected.languageServerPid;
			return await StandardLspClient.initialize(client, options, transportFailure);
		} catch (error) {
			client.abortStart();
			throw error;
		}
	}

	private static async initialize(
		client: StandardLspClient,
		options: LspClientOptions,
		transportFailure: Promise<never>,
	): Promise<StandardLspClient> {
		const { workspaceRoot } = client;

		const rootUri = pathToFileURL(workspaceRoot).href;
		const initializeParams: InitializeParams = {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: workspaceRoot.split(/[\\/]/).at(-1) ?? workspaceRoot }],
			capabilities: {
				workspace: {
					applyEdit: false,
					configuration: true,
					workspaceFolders: true,
					symbol: {},
					executeCommand: { dynamicRegistration: false },
					fileOperations: { dynamicRegistration: false, willRename: true, didRename: true },
				},
				textDocument: {
					synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
					definition: { dynamicRegistration: false, linkSupport: true },
					typeDefinition: { dynamicRegistration: false, linkSupport: true },
					references: { dynamicRegistration: false },
					implementation: { dynamicRegistration: false, linkSupport: true },
					hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
					documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
					publishDiagnostics: { relatedInformation: true, versionSupport: true },
					rename: { dynamicRegistration: false, prepareSupport: true },
					codeAction: {
						dynamicRegistration: false,
						codeActionLiteralSupport: {
							codeActionKind: {
								valueSet: [
									"",
									"quickfix",
									"refactor",
									"refactor.extract",
									"refactor.inline",
									"refactor.move",
									"refactor.rewrite",
									"source",
									"source.organizeImports",
									"source.fixAll",
									"notebook",
								],
							},
						},
						isPreferredSupport: true,
						disabledSupport: true,
						dataSupport: true,
						resolveSupport: { properties: ["edit", "command"] },
					},
				},
			},
			clientInfo: { name: "pi", version: "0.83.0" },
		};

		try {
			const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const timeoutFailure = new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new LanguageServerStartError("timeout", `语言服务器启动超过 ${startupTimeoutMs}ms。`)),
					startupTimeoutMs,
				);
			});
			const initialized = await Promise.race<InitializeResult>([
				client.connection.sendRequest(InitializeRequest.type, initializeParams),
				transportFailure,
				timeoutFailure,
			]);
			client.capabilities = initialized.capabilities;
			if (timeout) clearTimeout(timeout);
			await client.connection.sendNotification(InitializedNotification.type, {});
			return client;
		} catch (error) {
			client.abortStart();
			throw error;
		}
	}

	async openDocument(filePath: string): Promise<LspDocument> {
		const text = await readFile(filePath, "utf8");
		const uri = pathToFileURL(filePath).href;
		const current = this.documents.get(filePath);
		if (current?.text === text) return current;
		if (current) {
			const next = { ...current, version: current.version + 1, text };
			this.documents.set(filePath, next);
			await this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
				textDocument: { uri, version: next.version },
				contentChanges: [{ text }],
			});
			return next;
		}

		const document: LspDocument = {
			filePath,
			uri,
			languageId: this.adapter.languageId(filePath),
			version: 1,
			text,
		};
		this.documents.set(filePath, document);
		await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
			textDocument: {
				uri: document.uri,
				languageId: document.languageId,
				version: document.version,
				text: document.text,
			},
		});
		return document;
	}

	async definition(
		document: LspDocument,
		position: Position,
		signal?: AbortSignal,
	): Promise<Array<Location | LocationLink>> {
		if (this.adapter.id === "typescript") {
			try {
				const source = await this.sendRequest<Location[] | null>(
					"workspace/executeCommand",
					{ command: "_typescript.goToSourceDefinition", arguments: [document.uri, position] },
					signal,
				);
				if (source?.length) return source;
			} catch {
				// Older TypeScript servers may not support source definitions; use standard LSP below.
			}
		}
		const result = await this.sendRequest<Location | Location[] | LocationLink[] | null>(
			DefinitionRequest.method,
			{ textDocument: { uri: document.uri }, position },
			signal,
		);
		if (!result) return [];
		return Array.isArray(result) ? result : [result];
	}

	async typeDefinition(
		document: LspDocument,
		position: Position,
		signal?: AbortSignal,
	): Promise<Array<Location | LocationLink>> {
		const result = await this.sendRequest<Location | Location[] | LocationLink[] | null>(
			TypeDefinitionRequest.method,
			{ textDocument: { uri: document.uri }, position },
			signal,
		);
		if (!result) return [];
		return Array.isArray(result) ? result : [result];
	}

	async references(
		document: LspDocument,
		position: Position,
		includeDeclaration: boolean,
		signal?: AbortSignal,
	): Promise<Location[]> {
		return (
			(await this.sendRequest<Location[] | null>(
				ReferencesRequest.method,
				{ textDocument: { uri: document.uri }, position, context: { includeDeclaration } },
				signal,
			)) ?? []
		);
	}

	async implementation(
		document: LspDocument,
		position: Position,
		signal?: AbortSignal,
	): Promise<Array<Location | LocationLink>> {
		return (
			(await this.sendRequest<Array<Location | LocationLink> | null>(
				ImplementationRequest.method,
				{ textDocument: { uri: document.uri }, position },
				signal,
			)) ?? []
		);
	}

	hover(document: LspDocument, position: Position, signal?: AbortSignal): Promise<Hover | null> {
		return this.sendRequest<Hover | null>(
			HoverRequest.method,
			{ textDocument: { uri: document.uri }, position },
			signal,
		);
	}

	async documentSymbols(
		document: LspDocument,
		signal?: AbortSignal,
	): Promise<Array<DocumentSymbol | SymbolInformation>> {
		return (
			(await this.sendRequest<Array<DocumentSymbol | SymbolInformation> | null>(
				DocumentSymbolRequest.method,
				{ textDocument: { uri: document.uri } },
				signal,
			)) ?? []
		);
	}

	async workspaceSymbols(query: string, signal?: AbortSignal): Promise<Array<SymbolInformation | WorkspaceSymbol>> {
		return (
			(await this.sendRequest<Array<SymbolInformation | WorkspaceSymbol> | null>(
				WorkspaceSymbolRequest.method,
				{ query },
				signal,
			)) ?? []
		);
	}

	async diagnostics(document: LspDocument, signal?: AbortSignal, waitMs = 1_000): Promise<Diagnostic[]> {
		const key = normalizeDocumentUri(document.uri);
		const current = this.publishedDiagnostics.get(key);
		if (current?.length) return current;
		return new Promise<Diagnostic[]>((resolve, reject) => {
			let finished = false;
			const finish = (diagnostics: Diagnostic[]) => {
				if (finished) return;
				finished = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				const remaining = (this.diagnosticWaiters.get(key) ?? []).filter((waiter) => waiter !== finish);
				if (remaining.length > 0) this.diagnosticWaiters.set(key, remaining);
				else this.diagnosticWaiters.delete(key);
				resolve(diagnostics);
			};
			const onAbort = () => {
				if (finished) return;
				finished = true;
				clearTimeout(timeout);
				const remaining = (this.diagnosticWaiters.get(key) ?? []).filter((waiter) => waiter !== finish);
				if (remaining.length > 0) this.diagnosticWaiters.set(key, remaining);
				else this.diagnosticWaiters.delete(key);
				reject(new Error("LSP 请求已取消。"));
			};
			const timeout = setTimeout(() => finish(this.publishedDiagnostics.get(key) ?? []), waitMs);
			this.diagnosticWaiters.set(key, [...(this.diagnosticWaiters.get(key) ?? []), finish]);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	rename(
		document: LspDocument,
		position: Position,
		newName: string,
		signal?: AbortSignal,
	): Promise<WorkspaceEdit | null> {
		return this.sendRequest<WorkspaceEdit | null>(
			RenameRequest.method,
			{ textDocument: { uri: document.uri }, position, newName },
			signal,
		);
	}

	async codeActions(
		document: LspDocument,
		range: Range,
		diagnostics: Diagnostic[],
		only: string[] | undefined,
		signal?: AbortSignal,
	): Promise<Array<Command | CodeAction>> {
		return (
			(await this.sendRequest<Array<Command | CodeAction> | null>(
				CodeActionRequest.method,
				{
					textDocument: { uri: document.uri },
					range,
					context: { diagnostics, ...(only ? { only } : {}) },
				},
				signal,
			)) ?? []
		);
	}

	resolveCodeAction(action: CodeAction, signal?: AbortSignal): Promise<CodeAction> {
		return this.sendRequest<CodeAction>(CodeActionResolveRequest.method, action, signal);
	}

	async executeCommand(
		command: Command,
		signal?: AbortSignal,
		applyWorkspaceEdit?: (edit: WorkspaceEdit) => Promise<void>,
	): Promise<unknown> {
		if (this.applyWorkspaceEdit) throw new Error("另一个 LSP 代码操作仍在执行。");
		this.applyWorkspaceEdit = applyWorkspaceEdit;
		try {
			return await this.sendRequest("workspace/executeCommand", command, signal);
		} finally {
			this.applyWorkspaceEdit = undefined;
		}
	}

	willRenameFiles(oldPath: string, newPath: string, signal?: AbortSignal): Promise<WorkspaceEdit | null> {
		return this.sendRequest<WorkspaceEdit | null>(
			WillRenameFilesRequest.method,
			{ files: [{ oldUri: pathToFileURL(oldPath).href, newUri: pathToFileURL(newPath).href }] },
			signal,
		);
	}

	async didRenameFiles(oldPath: string, newPath: string): Promise<void> {
		const current = this.documents.get(oldPath);
		if (current) {
			await this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
				textDocument: { uri: current.uri },
			});
			this.documents.delete(oldPath);
		}
		await this.connection.sendNotification(DidRenameFilesNotification.type, {
			files: [{ oldUri: pathToFileURL(oldPath).href, newUri: pathToFileURL(newPath).href }],
		});
	}

	rawRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.sendRequest(method, params, signal);
	}

	async refreshOpenDocument(filePath: string): Promise<void> {
		if (this.documents.has(filePath)) await this.openDocument(filePath);
	}

	async reloadShared(): Promise<void> {
		if (this.transportKind === "shared" && !this.stopped) {
			await this.connection.sendRequest(LSP_BROKER_RELOAD_METHOD);
		}
	}

	isTransportBroken(error?: unknown): boolean {
		return (
			this.broken ||
			this.socket?.destroyed === true ||
			(error instanceof ConnectionError &&
				(error.code === ConnectionErrors.Closed || error.code === ConnectionErrors.Disposed)) ||
			(error instanceof ResponseError && error.code === LSP_BROKER_UPSTREAM_CLOSED_ERROR)
		);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		const child = this.child;
		try {
			await this.sendRequest<void>(ShutdownRequest.method, undefined, undefined, 1_000);
			await this.connection.sendNotification(ExitNotification.type);
			if (child) await waitForProcessExit(child, 1_000);
		} catch {
			// A failed server cannot complete the graceful shutdown handshake.
		} finally {
			this.connection.dispose();
			if (child?.exitCode === null && child.signalCode === null) {
				const exited = waitForProcessExit(child, 3_000);
				child.kill();
				await exited;
			}
			this.socket?.destroy();
		}
	}

	private abortStart(): void {
		this.stopped = true;
		this.connection.dispose();
		if (this.child?.exitCode === null) {
			try {
				this.child.kill();
			} catch {
				// A command that never spawned has no process to kill.
			}
		}
		this.socket?.destroy();
	}

	private async sendRequest<T>(
		method: string,
		params: unknown,
		signal?: AbortSignal,
		timeoutMs = this.requestTimeoutMs,
	): Promise<T> {
		if (this.stopped && method !== ShutdownRequest.method) throw new Error("语言服务器已经停止。");
		const cancellation = new CancellationTokenSource();
		const onAbort = () => cancellation.cancel();
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutFailure = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				cancellation.cancel();
				reject(new Error(`LSP 请求 ${method} 超过 ${timeoutMs}ms，已取消。`));
			}, timeoutMs);
		});
		try {
			return await Promise.race([
				this.connection.sendRequest<T>(method, params, cancellation.token),
				timeoutFailure,
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			cancellation.dispose();
		}
	}
}

class FallbackLspClient implements LspClient {
	readonly adapter: LanguageAdapter;
	readonly workspaceRoot: string;
	private active: StandardLspClient;
	private readonly launch: LanguageServerLaunch;
	private readonly options: LspClientOptions;
	private readonly identity: LspBrokerIdentity;
	private fallbackPromise: Promise<StandardLspClient> | undefined;

	constructor(
		active: StandardLspClient,
		adapter: LanguageAdapter,
		workspaceRoot: string,
		launch: LanguageServerLaunch,
		options: LspClientOptions,
		identity: LspBrokerIdentity,
	) {
		this.active = active;
		this.adapter = adapter;
		this.workspaceRoot = workspaceRoot;
		this.launch = launch;
		this.options = options;
		this.identity = identity;
	}

	get capabilities(): ServerCapabilities {
		return this.active.capabilities;
	}

	get transportKind(): "shared" | "private" {
		return this.active.transportKind;
	}

	get brokerPid(): number | undefined {
		return this.active.brokerPid;
	}

	get languageServerPid(): number | undefined {
		return this.active.languageServerPid;
	}

	openDocument(filePath: string): Promise<LspDocument> {
		return this.run((client) => client.openDocument(filePath));
	}

	definition(
		document: LspDocument,
		position: Position,
		signal?: AbortSignal,
	): Promise<Array<Location | LocationLink>> {
		return this.run(
			async (client) => client.definition(await this.document(client, document), position, signal),
			signal,
		);
	}

	typeDefinition(
		document: LspDocument,
		position: Position,
		signal?: AbortSignal,
	): Promise<Array<Location | LocationLink>> {
		return this.run(
			async (client) => client.typeDefinition(await this.document(client, document), position, signal),
			signal,
		);
	}

	references(
		document: LspDocument,
		position: Position,
		includeDeclaration: boolean,
		signal?: AbortSignal,
	): Promise<Location[]> {
		return this.run(
			async (client) =>
				client.references(await this.document(client, document), position, includeDeclaration, signal),
			signal,
		);
	}

	implementation(
		document: LspDocument,
		position: Position,
		signal?: AbortSignal,
	): Promise<Array<Location | LocationLink>> {
		return this.run(
			async (client) => client.implementation(await this.document(client, document), position, signal),
			signal,
		);
	}

	hover(document: LspDocument, position: Position, signal?: AbortSignal): Promise<Hover | null> {
		return this.run(async (client) => client.hover(await this.document(client, document), position, signal), signal);
	}

	documentSymbols(document: LspDocument, signal?: AbortSignal): Promise<Array<DocumentSymbol | SymbolInformation>> {
		return this.run(async (client) => client.documentSymbols(await this.document(client, document), signal), signal);
	}

	workspaceSymbols(query: string, signal?: AbortSignal): Promise<Array<SymbolInformation | WorkspaceSymbol>> {
		return this.run((client) => client.workspaceSymbols(query, signal), signal);
	}

	diagnostics(document: LspDocument, signal?: AbortSignal, waitMs?: number): Promise<Diagnostic[]> {
		return this.run(
			async (client) => client.diagnostics(await this.document(client, document), signal, waitMs),
			signal,
		);
	}

	rename(
		document: LspDocument,
		position: Position,
		newName: string,
		signal?: AbortSignal,
	): Promise<WorkspaceEdit | null> {
		return this.run(
			async (client) => client.rename(await this.document(client, document), position, newName, signal),
			signal,
		);
	}

	codeActions(
		document: LspDocument,
		range: Range,
		diagnostics: Diagnostic[],
		only: string[] | undefined,
		signal?: AbortSignal,
	): Promise<Array<Command | CodeAction>> {
		return this.run(
			async (client) => client.codeActions(await this.document(client, document), range, diagnostics, only, signal),
			signal,
		);
	}

	resolveCodeAction(action: CodeAction, signal?: AbortSignal): Promise<CodeAction> {
		return this.run((client) => client.resolveCodeAction(action, signal), signal);
	}

	executeCommand(
		command: Command,
		signal?: AbortSignal,
		applyWorkspaceEdit?: (edit: WorkspaceEdit) => Promise<void>,
	): Promise<unknown> {
		return this.run((client) => client.executeCommand(command, signal, applyWorkspaceEdit), signal);
	}

	willRenameFiles(oldPath: string, newPath: string, signal?: AbortSignal): Promise<WorkspaceEdit | null> {
		return this.run((client) => client.willRenameFiles(oldPath, newPath, signal), signal);
	}

	didRenameFiles(oldPath: string, newPath: string): Promise<void> {
		return this.run((client) => client.didRenameFiles(oldPath, newPath));
	}

	rawRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		return this.run((client) => client.rawRequest(method, params, signal), signal);
	}

	refreshOpenDocument(filePath: string): Promise<void> {
		return this.run((client) => client.refreshOpenDocument(filePath));
	}

	async reloadShared(): Promise<void> {
		if (this.active.transportKind === "shared") await this.active.reloadShared();
		else await reloadSharedBroker(this.identity, this.options.broker);
	}

	stop(): Promise<void> {
		return this.active.stop();
	}

	private async document(client: StandardLspClient, document: LspDocument): Promise<LspDocument> {
		return client === this.active && client.transportKind === "shared"
			? document
			: client.openDocument(document.filePath);
	}

	private async run<T>(operation: (client: StandardLspClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const original = this.active;
		try {
			return await operation(original);
		} catch (error) {
			if (signal?.aborted || original.transportKind !== "shared" || !original.isTransportBroken(error)) throw error;
			const fallback = await this.fallback();
			return operation(fallback);
		}
	}

	private async fallback(): Promise<StandardLspClient> {
		if (!this.fallbackPromise) {
			this.fallbackPromise = StandardLspClient.start(this.adapter, this.workspaceRoot, this.launch, {
				...this.options,
				broker: { enabled: false },
			});
		}
		this.active = await this.fallbackPromise;
		return this.active;
	}
}

export async function startLanguageClient(
	adapter: LanguageAdapter,
	workspaceRoot: string,
	options: LspClientOptions = {},
): Promise<LspClient> {
	let lastNotFound: LanguageServerStartError | undefined;
	for (const launch of adapter.launchCandidates()) {
		const identity = lspBrokerIdentity(workspaceRoot, adapter.id, launch);
		const shared = await connectSharedBroker(identity, options.broker);
		if (shared) {
			try {
				const client = await StandardLspClient.startShared(adapter, workspaceRoot, shared, identity, options);
				return new FallbackLspClient(client, adapter, workspaceRoot, launch, options, identity);
			} catch {
				shared.socket.destroy();
			}
		}
		try {
			const client = await StandardLspClient.start(adapter, workspaceRoot, launch, options);
			return options.broker?.enabled === false
				? client
				: new FallbackLspClient(client, adapter, workspaceRoot, launch, options, identity);
		} catch (error) {
			if (error instanceof LanguageServerStartError && error.kind === "not-found") {
				lastNotFound = error;
				continue;
			}
			throw error;
		}
	}
	throw lastNotFound ?? new LanguageServerStartError("not-found", `找不到 ${adapter.displayName} 语言服务器。`);
}
