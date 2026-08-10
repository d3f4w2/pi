import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import spawn from "cross-spawn";
import {
	createMessageConnection,
	type MessageConnection,
	ResponseError,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
	DidChangeTextDocumentNotification,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	ExitNotification,
	InitializedNotification,
	InitializeRequest,
	ShutdownRequest,
} from "vscode-languageserver-protocol";
import {
	assertBrokerIdentity,
	LSP_BROKER_CONNECT_METHOD,
	LSP_BROKER_HEALTH_METHOD,
	LSP_BROKER_PROTOCOL_VERSION,
	LSP_BROKER_RELOAD_METHOD,
	type LspBrokerConnectResult,
	type LspBrokerHealth,
	type LspBrokerIdentity,
} from "./broker-protocol.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_NEGATIVE_CACHE_MS = 30_000;

interface BrokerDocument {
	languageId: string;
	text: string;
	version: number;
	clients: Set<number>;
}

interface BrokerSession {
	id: number;
	socket: Socket;
	connection: MessageConnection;
	connected: boolean;
	documents: Set<string>;
}

export interface LspBrokerServerOptions {
	identity: LspBrokerIdentity;
	endpoint: string;
	idleTimeoutMs?: number;
	negativeCacheMs?: number;
	onClose?: () => void;
}

function logger() {
	return { error: () => {}, warn: () => {}, info: () => {}, log: () => {} };
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function removeStaleUnixSocket(endpoint: string): Promise<void> {
	const state = await new Promise<"active" | "stale" | "missing">((resolve) => {
		const socket = createConnection(endpoint);
		socket.once("connect", () => {
			socket.destroy();
			resolve("active");
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			resolve(error.code === "ENOENT" ? "missing" : "stale");
		});
	});
	if (state === "active") throw new Error(`LSP broker socket 已被占用：${endpoint}`);
	if (state === "stale") await rm(endpoint, { force: true });
}

export class LspBrokerServer {
	private readonly identity: LspBrokerIdentity;
	private readonly endpoint: string;
	private readonly idleTimeoutMs: number;
	private readonly negativeCacheMs: number;
	private readonly onClose: (() => void) | undefined;
	private readonly sessions = new Map<number, BrokerSession>();
	private readonly documents = new Map<string, BrokerDocument>();
	private readonly activeRequestSessions: BrokerSession[] = [];
	private readonly child: ReturnType<typeof spawn>;
	private readonly languageConnection: MessageConnection;
	private server: Server | undefined;
	private nextSessionId = 1;
	private initializeResult: unknown;
	private initializePromise: Promise<unknown> | undefined;
	private initializeFailure: { message: string; until: number } | undefined;
	private initializedSent = false;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private closing = false;

	constructor(options: LspBrokerServerOptions) {
		this.identity = options.identity;
		this.endpoint = options.endpoint;
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.negativeCacheMs = options.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS;
		this.onClose = options.onClose;
		this.child = spawn(this.identity.launch.command, this.identity.launch.args, {
			cwd: this.identity.projectRoot,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
		if (!this.child.stdout || !this.child.stdin) throw new Error("LSP broker 无法创建语言服务器标准流。");
		this.child.once("error", () => void this.close());
		this.child.once("exit", () => void this.close());
		this.languageConnection = createMessageConnection(
			new StreamMessageReader(this.child.stdout),
			new StreamMessageWriter(this.child.stdin),
			logger(),
		);
		this.languageConnection.onRequest(async (method, params, token) => {
			const target =
				this.activeRequestSessions
					.slice()
					.reverse()
					.find((session) => session.connected) ??
				[...this.sessions.values()].find((session) => session.connected);
			if (!target) throw new ResponseError(-32002, "没有可处理语言服务器请求的 LSP 客户端。");
			return target.connection.sendRequest(method, params, token);
		});
		this.languageConnection.onNotification(async (method, params) => {
			await Promise.all(
				[...this.sessions.values()]
					.filter((session) => session.connected)
					.map((session) => session.connection.sendNotification(method, params)),
			);
		});
		this.languageConnection.listen();
	}

	async listen(): Promise<void> {
		if (this.server) return;
		if (process.platform !== "win32") await removeStaleUnixSocket(this.endpoint);
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(this.endpoint, () => {
				server.off("error", onError);
				resolve();
			});
		});
		if (process.platform !== "win32") await chmod(this.endpoint, 0o600);
		this.scheduleIdleExit();
	}

	health(): LspBrokerHealth {
		return {
			protocolVersion: LSP_BROKER_PROTOCOL_VERSION,
			cacheKey: this.identity.cacheKey,
			projectRoot: this.identity.projectRoot,
			clientCount: [...this.sessions.values()].filter((session) => session.connected).length,
			brokerPid: process.pid,
			...(this.child.pid === undefined ? {} : { languageServerPid: this.child.pid }),
			status: this.initializeFailure ? "failed" : this.initializeResult ? "ready" : "starting",
			...(this.initializeFailure ? { negativeCacheUntil: this.initializeFailure.until } : {}),
		};
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		for (const session of this.sessions.values()) {
			session.connection.dispose();
			session.socket.destroy();
		}
		this.sessions.clear();
		if (this.initializeResult) {
			try {
				await this.languageConnection.sendRequest(ShutdownRequest.method);
				await this.languageConnection.sendNotification(ExitNotification.method);
			} catch {}
		}
		this.languageConnection.dispose();
		if (this.child.exitCode === null) {
			const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
			this.child.kill();
			await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
		}
		if (this.server) {
			await new Promise<void>((resolve) => this.server?.close(() => resolve()));
			this.server = undefined;
		}
		if (process.platform !== "win32") await rm(this.endpoint, { force: true });
		this.onClose?.();
	}

	private accept(socket: Socket): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const id = this.nextSessionId++;
		const connection = createMessageConnection(
			new StreamMessageReader(socket),
			new StreamMessageWriter(socket),
			logger(),
		);
		const session: BrokerSession = { id, socket, connection, connected: false, documents: new Set() };
		this.sessions.set(id, session);
		connection.onRequest((method, params, token) => this.handleRequest(session, method, params, token));
		connection.onNotification((method, params) => this.handleNotification(session, method, params));
		connection.onClose(() => this.detach(session));
		connection.listen();
	}

	private async handleRequest(
		session: BrokerSession,
		method: string,
		params: unknown,
		token: Parameters<MessageConnection["sendRequest"]>[2],
	): Promise<unknown> {
		if (method === LSP_BROKER_HEALTH_METHOD) return this.health();
		if (method === LSP_BROKER_CONNECT_METHOD) {
			assertBrokerIdentity(this.identity, params);
			session.connected = true;
			const result: LspBrokerConnectResult = this.health();
			return result;
		}
		if (!session.connected) throw new ResponseError(-32001, "必须先完成 LSP broker 握手。");
		if (method === LSP_BROKER_RELOAD_METHOD) {
			this.initializeFailure = undefined;
			setTimeout(() => void this.close(), 25);
			return { reloading: true };
		}
		if (method === InitializeRequest.method) return this.initialize(params, token);
		if (method === ShutdownRequest.method) return null;
		this.activeRequestSessions.push(session);
		try {
			return await this.languageConnection.sendRequest(method, params, token);
		} finally {
			const index = this.activeRequestSessions.lastIndexOf(session);
			if (index >= 0) this.activeRequestSessions.splice(index, 1);
		}
	}

	private async handleNotification(session: BrokerSession, method: string, params: unknown): Promise<void> {
		if (!session.connected) return;
		if (method === ExitNotification.method) {
			session.connection.dispose();
			session.socket.end();
			return;
		}
		if (method === InitializedNotification.method) {
			if (!this.initializedSent) {
				this.initializedSent = true;
				await this.languageConnection.sendNotification(method, params);
			}
			return;
		}
		if (method === DidOpenTextDocumentNotification.method) {
			await this.openDocument(session, params);
			return;
		}
		if (method === DidChangeTextDocumentNotification.method) {
			await this.changeDocument(params);
			return;
		}
		if (method === DidCloseTextDocumentNotification.method) {
			await this.closeDocument(session, params);
			return;
		}
		await this.languageConnection.sendNotification(method, params);
	}

	private async initialize(params: unknown, token: Parameters<MessageConnection["sendRequest"]>[2]): Promise<unknown> {
		if (this.initializeResult) return this.initializeResult;
		if (this.initializeFailure) {
			if (this.initializeFailure.until > Date.now()) throw new Error(this.initializeFailure.message);
			this.initializeFailure = undefined;
		}
		if (!this.initializePromise) {
			this.initializePromise = this.languageConnection.sendRequest(InitializeRequest.method, params, token).then(
				(result) => {
					this.initializeResult = result;
					return result;
				},
				(error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					this.initializeFailure = { message, until: Date.now() + this.negativeCacheMs };
					this.initializePromise = undefined;
					throw error;
				},
			);
		}
		return this.initializePromise;
	}

	private async openDocument(session: BrokerSession, params: unknown): Promise<void> {
		const textDocument = record(record(params).textDocument);
		const uri = typeof textDocument.uri === "string" ? textDocument.uri : undefined;
		if (!uri) return;
		const current = this.documents.get(uri);
		session.documents.add(uri);
		if (!current) {
			this.documents.set(uri, {
				languageId: typeof textDocument.languageId === "string" ? textDocument.languageId : "",
				text: typeof textDocument.text === "string" ? textDocument.text : "",
				version: 1,
				clients: new Set([session.id]),
			});
			await this.languageConnection.sendNotification(DidOpenTextDocumentNotification.method, {
				textDocument: { ...textDocument, version: 1 },
			});
			return;
		}
		current.clients.add(session.id);
		if (typeof textDocument.text === "string" && textDocument.text !== current.text) {
			current.text = textDocument.text;
			current.version++;
			await this.languageConnection.sendNotification(DidChangeTextDocumentNotification.method, {
				textDocument: { uri, version: current.version },
				contentChanges: [{ text: current.text }],
			});
		}
	}

	private async changeDocument(params: unknown): Promise<void> {
		const value = record(params);
		const textDocument = record(value.textDocument);
		const uri = typeof textDocument.uri === "string" ? textDocument.uri : undefined;
		const changes = Array.isArray(value.contentChanges) ? value.contentChanges : [];
		const last = changes.at(-1);
		const current = uri ? this.documents.get(uri) : undefined;
		if (!uri || !current || !last || typeof last !== "object" || !("text" in last) || typeof last.text !== "string") {
			return;
		}
		current.text = last.text;
		current.version++;
		await this.languageConnection.sendNotification(DidChangeTextDocumentNotification.method, {
			textDocument: { uri, version: current.version },
			contentChanges: [{ text: current.text }],
		});
	}

	private async closeDocument(session: BrokerSession, params: unknown): Promise<void> {
		const textDocument = record(record(params).textDocument);
		const uri = typeof textDocument.uri === "string" ? textDocument.uri : undefined;
		if (!uri) return;
		await this.releaseDocument(session, uri);
	}

	private async releaseDocument(session: BrokerSession, uri: string): Promise<void> {
		session.documents.delete(uri);
		const current = this.documents.get(uri);
		if (!current) return;
		current.clients.delete(session.id);
		if (current.clients.size > 0) return;
		this.documents.delete(uri);
		await this.languageConnection.sendNotification(DidCloseTextDocumentNotification.method, {
			textDocument: { uri },
		});
	}

	private detach(session: BrokerSession): void {
		if (!this.sessions.delete(session.id)) return;
		for (const uri of session.documents) void this.releaseDocument(session, uri);
		this.scheduleIdleExit();
	}

	private scheduleIdleExit(): void {
		if (this.closing || [...this.sessions.values()].some((session) => session.connected)) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.close(), this.idleTimeoutMs);
	}
}

export function assertLocalBrokerEndpoint(endpoint: string): void {
	if (process.platform === "win32") {
		if (!endpoint.startsWith("\\\\.\\pipe\\pi-go-lsp-"))
			throw new Error("Windows LSP broker 必须使用本地 named pipe。");
		return;
	}
	if (path.dirname(endpoint) !== path.resolve(path.dirname(endpoint))) {
		throw new Error("Unix LSP broker socket 必须使用绝对本地路径。");
	}
}
