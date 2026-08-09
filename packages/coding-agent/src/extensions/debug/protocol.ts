import type { DapEvent, DapMessage, DapResponse, DapTransport } from "./types.ts";

const HEADER_DELIMITER = Buffer.from("\r\n\r\n", "ascii");
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingResponse {
	resolve(response: DapResponse): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
	resolve(event: DapEvent): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessage(value: unknown): DapMessage | undefined {
	if (!isRecord(value) || typeof value.seq !== "number" || typeof value.type !== "string") return undefined;
	if (value.type === "response") {
		if (
			typeof value.request_seq !== "number" ||
			typeof value.success !== "boolean" ||
			typeof value.command !== "string"
		)
			return undefined;
		return value as unknown as DapResponse;
	}
	if (value.type === "event") {
		if (typeof value.event !== "string") return undefined;
		return value as unknown as DapEvent;
	}
	if (value.type === "request" && typeof value.command === "string") return value as unknown as DapMessage;
	return undefined;
}

export function encodeDapMessage(message: DapMessage): Uint8Array {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export class DapMessageParser {
	private buffer = Buffer.alloc(0);

	push(chunk: Uint8Array): DapMessage[] {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
		const messages: DapMessage[] = [];
		for (;;) {
			const headerEnd = this.buffer.indexOf(HEADER_DELIMITER);
			if (headerEnd === -1) break;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /^Content-Length:\s*(\d+)$/im.exec(header);
			if (!match) throw new Error("DAP 消息缺少 Content-Length。");
			const length = Number.parseInt(match[1] ?? "", 10);
			if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
				throw new Error("DAP 消息长度无效。");
			}
			const bodyStart = headerEnd + HEADER_DELIMITER.length;
			if (this.buffer.length < bodyStart + length) break;
			const raw = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
			this.buffer = this.buffer.subarray(bodyStart + length);
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				throw new Error("DAP 返回了无效 JSON。");
			}
			const message = parseMessage(parsed);
			if (!message) throw new Error("DAP 返回了无法识别的消息。");
			messages.push(message);
		}
		return messages;
	}
}

export class DapClient {
	private readonly transport: DapTransport;
	private readonly parser = new DapMessageParser();
	private readonly pending = new Map<number, PendingResponse>();
	private readonly waiters = new Map<string, EventWaiter[]>();
	private readonly queuedEvents = new Map<string, DapEvent[]>();
	private readonly eventListeners = new Set<(event: DapEvent) => void>();
	private sequence = 1;
	private closed = false;

	constructor(transport: DapTransport) {
		this.transport = transport;
		transport.onData((data) => {
			try {
				for (const message of this.parser.push(data)) this.handle(message);
			} catch (error) {
				this.closeWithError(error instanceof Error ? error : new Error(String(error)));
			}
		});
		transport.onClose((error) => this.closeWithError(error ?? new Error("DAP 连接已关闭。")));
	}

	onEvent(listener: (event: DapEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	private handle(message: DapMessage): void {
		if (message.type === "response") {
			const pending = this.pending.get(message.request_seq);
			if (!pending) return;
			this.pending.delete(message.request_seq);
			clearTimeout(pending.timer);
			if (message.success) pending.resolve(message);
			else pending.reject(new Error(message.message || `${message.command} 失败。`));
			return;
		}
		if (message.type === "event") {
			for (const listener of this.eventListeners) listener(message);
			const waiters = this.waiters.get(message.event);
			const waiter = waiters?.shift();
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(message);
				if (waiters?.length === 0) this.waiters.delete(message.event);
			} else {
				const queue = this.queuedEvents.get(message.event) ?? [];
				queue.push(message);
				this.queuedEvents.set(message.event, queue.slice(-10));
			}
			return;
		}
		this.sendReverseRequestFailure(message.seq, message.command);
	}

	private sendReverseRequestFailure(requestSequence: number, command: string): void {
		const response: DapResponse = {
			seq: this.sequence++,
			type: "response",
			request_seq: requestSequence,
			success: false,
			command,
			message: `Pi 不支持调试适配器的反向请求：${command}`,
		};
		this.transport.write(encodeDapMessage(response));
	}

	request(
		command: string,
		args: Record<string, unknown> = {},
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<DapResponse> {
		if (this.closed) return Promise.reject(new Error("DAP 连接已经关闭。"));
		const seq = this.sequence++;
		return new Promise<DapResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`DAP 请求 ${command} 超时。`));
			}, timeoutMs);
			this.pending.set(seq, { resolve, reject, timer });
			try {
				this.transport.write(encodeDapMessage({ seq, type: "request", command, arguments: args }));
			} catch (error) {
				this.pending.delete(seq);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	waitForEvent(event: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<DapEvent> {
		const queued = this.queuedEvents.get(event)?.shift();
		if (queued) return Promise.resolve(queued);
		if (this.closed) return Promise.reject(new Error("DAP 连接已经关闭。"));
		return new Promise<DapEvent>((resolve, reject) => {
			const timer = setTimeout(() => {
				const waiters = this.waiters.get(event);
				if (waiters)
					this.waiters.set(
						event,
						waiters.filter((waiter) => waiter.resolve !== resolve),
					);
				reject(new Error(`等待 DAP 事件 ${event} 超时。`));
			}, timeoutMs);
			const waiters = this.waiters.get(event) ?? [];
			waiters.push({ resolve, reject, timer });
			this.waiters.set(event, waiters);
		});
	}

	private closeWithError(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiters of this.waiters.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}
		this.waiters.clear();
	}

	async dispose(): Promise<void> {
		this.closeWithError(new Error("DAP 会话已结束。"));
		await this.transport.dispose();
	}
}
