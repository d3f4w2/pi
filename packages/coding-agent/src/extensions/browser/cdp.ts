import { WebSocket } from "undici";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface CdpTransport {
	send(message: string): void;
	onMessage(listener: (message: string) => void): () => void;
	onClose(listener: (error?: Error) => void): () => void;
	close(): void;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
	signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cdpError(value: unknown): Error {
	if (!isRecord(value)) return new Error("浏览器返回了未知错误。");
	const message = typeof value.message === "string" ? value.message : "浏览器命令失败。";
	return new Error(message.slice(0, 1_000));
}

export class CdpClient {
	private readonly transport: CdpTransport;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>();
	private readonly removeMessageListener: () => void;
	private readonly removeCloseListener: () => void;
	private nextId = 1;
	private closed = false;

	constructor(transport: CdpTransport) {
		this.transport = transport;
		this.removeMessageListener = transport.onMessage((message) => this.handleMessage(message));
		this.removeCloseListener = transport.onClose((error) => this.handleClose(error));
	}

	static async connect(url: string, signal?: AbortSignal): Promise<CdpClient> {
		return new CdpClient(await WebSocketCdpTransport.connect(url, signal));
	}

	on(method: string, listener: (params: unknown) => void): () => void {
		const listeners = this.eventListeners.get(method) ?? new Set();
		listeners.add(listener);
		this.eventListeners.set(method, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.eventListeners.delete(method);
		};
	}

	request<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<T> {
		if (this.closed) return Promise.reject(new Error("浏览器连接已关闭。"));
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("浏览器操作已取消。"));
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				reject(signal?.reason instanceof Error ? signal.reason : new Error("浏览器操作已取消。"));
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
				reject(new Error(`浏览器命令超时：${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
				timer,
				...(signal === undefined ? {} : { signal, onAbort }),
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.transport.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.transport.close();
		this.handleClose();
	}

	private handleMessage(message: string): void {
		if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
			this.handleClose(new Error("Browser CDP message exceeds the 32 MB safety limit."));
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		if (typeof parsed.id === "number") {
			const pending = this.pending.get(parsed.id);
			if (!pending) return;
			this.pending.delete(parsed.id);
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.onAbort ?? (() => {}));
			if (parsed.error !== undefined) pending.reject(cdpError(parsed.error));
			else pending.resolve(parsed.result ?? {});
			return;
		}
		if (typeof parsed.method !== "string") return;
		for (const listener of this.eventListeners.get(parsed.method) ?? []) listener(parsed.params);
	}

	private handleClose(error?: Error): void {
		if (!this.closed) this.closed = true;
		this.removeMessageListener();
		this.removeCloseListener();
		const reason = error ?? new Error("浏览器连接已关闭。");
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.signal?.removeEventListener("abort", pending.onAbort ?? (() => {}));
			pending.reject(reason);
		}
		this.pending.clear();
	}
}

class WebSocketCdpTransport implements CdpTransport {
	private readonly socket: InstanceType<typeof WebSocket>;
	private readonly messageListeners = new Set<(message: string) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();

	private constructor(socket: InstanceType<typeof WebSocket>) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			for (const listener of this.messageListeners) listener(event.data);
		});
		socket.addEventListener("close", () => {
			for (const listener of this.closeListeners) listener();
		});
		socket.addEventListener("error", (event) => {
			const error = new Error(event.message || "浏览器 WebSocket 连接失败。");
			for (const listener of this.closeListeners) listener(error);
		});
	}

	static connect(url: string, signal?: AbortSignal): Promise<WebSocketCdpTransport> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error("连接浏览器超时。"));
			}, DEFAULT_REQUEST_TIMEOUT_MS);
			const onAbort = (): void => {
				socket.close();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("连接浏览器已取消。"));
			};
			const cleanup = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			socket.addEventListener(
				"open",
				() => {
					cleanup();
					resolve(new WebSocketCdpTransport(socket));
				},
				{ once: true },
			);
			socket.addEventListener(
				"error",
				(event) => {
					cleanup();
					reject(new Error(event.message || "连接浏览器失败。"));
				},
				{ once: true },
			);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	send(message: string): void {
		this.socket.send(message);
	}

	onMessage(listener: (message: string) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.socket.close();
	}
}
