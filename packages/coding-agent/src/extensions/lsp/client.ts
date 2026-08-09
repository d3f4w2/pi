import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import spawn from "cross-spawn";
import {
	CancellationTokenSource,
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
	Diagnostic,
	DocumentSymbol,
	Hover,
	InitializeParams,
	InitializeResult,
	Location,
	LocationLink,
	Position,
	PublishDiagnosticsParams,
	SymbolInformation,
	WorkspaceEdit,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import {
	ApplyWorkspaceEditRequest,
	ConfigurationRequest,
	DefinitionRequest,
	DidChangeTextDocumentNotification,
	DidOpenTextDocumentNotification,
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
	WorkspaceFoldersRequest,
	WorkspaceSymbolRequest,
} from "vscode-languageserver-protocol";
import type { LanguageAdapter, LanguageServerLaunch, LspClient, LspClientOptions, LspDocument } from "./types.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

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

class StandardLspClient implements LspClient {
	readonly adapter: LanguageAdapter;
	readonly workspaceRoot: string;
	private readonly child: ReturnType<typeof spawn>;
	private readonly connection: MessageConnection;
	private readonly requestTimeoutMs: number;
	private readonly documents = new Map<string, LspDocument>();
	private readonly publishedDiagnostics = new Map<string, Diagnostic[]>();
	private readonly diagnosticWaiters = new Map<string, Array<(diagnostics: Diagnostic[]) => void>>();
	private stopped = false;

	private constructor(
		adapter: LanguageAdapter,
		workspaceRoot: string,
		launch: LanguageServerLaunch,
		requestTimeoutMs: number,
	) {
		this.adapter = adapter;
		this.workspaceRoot = workspaceRoot;
		this.requestTimeoutMs = requestTimeoutMs;
		this.child = spawn(launch.command, launch.args, {
			cwd: workspaceRoot,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
		if (!this.child.stdout || !this.child.stdin) throw new Error("语言服务器没有可用的标准输入输出流。");
		this.connection = createMessageConnection(
			new StreamMessageReader(this.child.stdout),
			new StreamMessageWriter(this.child.stdin),
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
		this.connection.onRequest(ApplyWorkspaceEditRequest.type, () => ({
			applied: false,
			failureReason: "Pi 只会应用由 lsp rename 明确请求的编辑。",
		}));
		this.connection.onNotification(PublishDiagnosticsNotification.type, (params: PublishDiagnosticsParams) => {
			const key = normalizeDocumentUri(params.uri);
			this.publishedDiagnostics.set(key, params.diagnostics);
			if (params.diagnostics.length === 0) return;
			const waiters = this.diagnosticWaiters.get(key) ?? [];
			this.diagnosticWaiters.delete(key);
			for (const resolve of waiters) resolve(params.diagnostics);
		});
		this.connection.listen();
	}

	static async start(
		adapter: LanguageAdapter,
		workspaceRoot: string,
		launch: LanguageServerLaunch,
		options: LspClientOptions = {},
	): Promise<StandardLspClient> {
		const client = new StandardLspClient(
			adapter,
			workspaceRoot,
			launch,
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		);
		const processFailure = new Promise<never>((_resolve, reject) => {
			client.child.once("error", (error) => {
				const code = (error as NodeJS.ErrnoException).code;
				reject(
					new LanguageServerStartError(
						code === "ENOENT" ? "not-found" : "failed",
						code === "ENOENT" ? `找不到语言服务器命令：${launch.command}` : error.message,
					),
				);
			});
			client.child.once("exit", (code, signal) => {
				reject(
					new LanguageServerStartError(
						"failed",
						`语言服务器在初始化前退出（code=${code ?? "null"}, signal=${signal ?? "none"}）。`,
					),
				);
			});
		});
		processFailure.catch(() => {});

		const rootUri = pathToFileURL(workspaceRoot).href;
		const initializeParams: InitializeParams = {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: workspaceRoot.split(/[\\/]/).at(-1) ?? workspaceRoot }],
			capabilities: {
				workspace: { applyEdit: false, configuration: true, workspaceFolders: true, symbol: {} },
				textDocument: {
					synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
					definition: { dynamicRegistration: false, linkSupport: true },
					references: { dynamicRegistration: false },
					implementation: { dynamicRegistration: false, linkSupport: true },
					hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
					documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
					publishDiagnostics: { relatedInformation: true, versionSupport: true },
					rename: { dynamicRegistration: false, prepareSupport: true },
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
			await Promise.race<InitializeResult>([
				client.connection.sendRequest(InitializeRequest.type, initializeParams),
				processFailure,
				timeoutFailure,
			]);
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
				const source = await this.request<Location[] | null>(
					"workspace/executeCommand",
					{ command: "_typescript.goToSourceDefinition", arguments: [document.uri, position] },
					signal,
				);
				if (source?.length) return source;
			} catch {
				// Older TypeScript servers may not support source definitions; use standard LSP below.
			}
		}
		const result = await this.request<Location | Location[] | LocationLink[] | null>(
			DefinitionRequest.method,
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
			(await this.request<Location[] | null>(
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
			(await this.request<Array<Location | LocationLink> | null>(
				ImplementationRequest.method,
				{ textDocument: { uri: document.uri }, position },
				signal,
			)) ?? []
		);
	}

	hover(document: LspDocument, position: Position, signal?: AbortSignal): Promise<Hover | null> {
		return this.request<Hover | null>(HoverRequest.method, { textDocument: { uri: document.uri }, position }, signal);
	}

	async documentSymbols(
		document: LspDocument,
		signal?: AbortSignal,
	): Promise<Array<DocumentSymbol | SymbolInformation>> {
		return (
			(await this.request<Array<DocumentSymbol | SymbolInformation> | null>(
				DocumentSymbolRequest.method,
				{ textDocument: { uri: document.uri } },
				signal,
			)) ?? []
		);
	}

	async workspaceSymbols(query: string, signal?: AbortSignal): Promise<Array<SymbolInformation | WorkspaceSymbol>> {
		return (
			(await this.request<Array<SymbolInformation | WorkspaceSymbol> | null>(
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
		return this.request<WorkspaceEdit | null>(
			RenameRequest.method,
			{ textDocument: { uri: document.uri }, position, newName },
			signal,
		);
	}

	async refreshOpenDocument(filePath: string): Promise<void> {
		if (this.documents.has(filePath)) await this.openDocument(filePath);
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		try {
			await this.request<void>(ShutdownRequest.method, undefined, undefined, 1_000);
			await this.connection.sendNotification(ExitNotification.type);
			if (this.child.exitCode === null) {
				await Promise.race([
					new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
					new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
				]);
			}
		} catch {
			// A failed server cannot complete the graceful shutdown handshake.
		} finally {
			this.connection.dispose();
			if (this.child.exitCode === null) this.child.kill();
		}
	}

	private abortStart(): void {
		this.stopped = true;
		this.connection.dispose();
		if (this.child.exitCode === null) {
			try {
				this.child.kill();
			} catch {
				// A command that never spawned has no process to kill.
			}
		}
	}

	private async request<T>(
		method: string,
		params: object | undefined,
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

export async function startLanguageClient(
	adapter: LanguageAdapter,
	workspaceRoot: string,
	options: LspClientOptions = {},
): Promise<LspClient> {
	let lastNotFound: LanguageServerStartError | undefined;
	for (const launch of adapter.launchCandidates()) {
		try {
			return await StandardLspClient.start(adapter, workspaceRoot, launch, options);
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
