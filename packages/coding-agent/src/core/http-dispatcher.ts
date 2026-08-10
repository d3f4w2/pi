import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
const PRECONNECT_TIMEOUT_MS = 5_000;
const PRECONNECT_TTL_MS = 30_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
interface PreconnectedSocket {
	socket: Socket | TLSSocket;
	timeout: ReturnType<typeof setTimeout>;
}

const preconnectedSockets = new Map<string, PreconnectedSocket>();
const pendingPreconnects = new Map<string, Promise<boolean>>();

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	const normalizedOrigin = new URL(origin).origin;
	const clientOptions = options as undici.Client.Options;
	const fallbackConnector =
		typeof clientOptions.connect === "function"
			? clientOptions.connect
			: undici.buildConnector(clientOptions.connect);
	const connector: undici.buildConnector.connector = (connectOptions, callback) => {
		const preconnected = preconnectedSockets.get(normalizedOrigin);
		if (preconnected) {
			preconnectedSockets.delete(normalizedOrigin);
			clearTimeout(preconnected.timeout);
			if (!preconnected.socket.destroyed) {
				preconnected.socket.ref();
				queueMicrotask(() => callback(null, preconnected.socket));
				return;
			}
		}
		fallbackConnector(connectOptions, callback);
	};
	return withUndiciErrorListener(new undici.Client(origin, { ...clientOptions, connect: connector }));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}

function proxyConfigured(): boolean {
	return Boolean(
		process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy,
	);
}

export function preconnectHttpOrigin(input: string | URL, signal?: AbortSignal): Promise<boolean> {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return Promise.resolve(false);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || proxyConfigured()) {
		return Promise.resolve(false);
	}
	if (signal?.aborted) return Promise.resolve(false);
	const origin = url.origin;
	const cached = preconnectedSockets.get(origin);
	if (cached && !cached.socket.destroyed) return Promise.resolve(true);
	const pending = pendingPreconnects.get(origin);
	if (pending) return pending;

	const promise = new Promise<boolean>((resolve) => {
		let settled = false;
		const connector = undici.buildConnector({
			allowH2: false,
			autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			timeout: PRECONNECT_TIMEOUT_MS,
		});
		const finish = (connected: boolean): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(connected);
		};
		const onAbort = (): void => finish(false);
		signal?.addEventListener("abort", onAbort, { once: true });
		connector(
			{
				hostname: url.hostname,
				host: url.host,
				protocol: url.protocol,
				port: url.port || (url.protocol === "https:" ? "443" : "80"),
				servername: url.hostname,
			},
			(error, socket) => {
				if (error || !socket || signal?.aborted || settled) {
					socket?.destroy();
					finish(false);
					return;
				}
				socket.unref();
				const timeout = setTimeout(() => {
					const current = preconnectedSockets.get(origin);
					if (current?.socket !== socket) return;
					preconnectedSockets.delete(origin);
					socket.destroy();
				}, PRECONNECT_TTL_MS);
				timeout.unref();
				preconnectedSockets.set(origin, { socket, timeout });
				finish(true);
			},
		);
	}).finally(() => {
		pendingPreconnects.delete(origin);
	});
	pendingPreconnects.set(origin, promise);
	return promise;
}
