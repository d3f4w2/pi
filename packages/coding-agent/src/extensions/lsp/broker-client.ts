import { access } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { isBunBinary } from "../../config.ts";
import {
	LSP_BROKER_CONNECT_METHOD,
	LSP_BROKER_HEALTH_METHOD,
	LSP_BROKER_RELOAD_METHOD,
	type LspBrokerHealth,
	type LspBrokerIdentity,
	lspBrokerEndpoint,
} from "./broker-protocol.ts";
import type { LspBrokerClientOptions } from "./types.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const RETRY_INTERVAL_MS = 20;

function logger() {
	return { error: () => {}, warn: () => {}, info: () => {}, log: () => {} };
}

function connectSocket(endpoint: string, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(endpoint);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`连接 LSP broker 超过 ${timeoutMs}ms。`));
		}, timeoutMs);
		const finish = () => clearTimeout(timeout);
		socket.once("connect", () => {
			finish();
			resolve(socket);
		});
		socket.once("error", (error) => {
			finish();
			reject(error);
		});
	});
}

async function probe(endpoint: string, timeoutMs: number): Promise<LspBrokerHealth> {
	const socket = await connectSocket(endpoint, timeoutMs);
	const connection = createMessageConnection(
		new StreamMessageReader(socket),
		new StreamMessageWriter(socket),
		logger(),
	);
	connection.listen();
	try {
		return await connection.sendRequest<LspBrokerHealth>(LSP_BROKER_HEALTH_METHOD);
	} finally {
		connection.dispose();
		socket.destroy();
	}
}

async function workerPath(): Promise<string | undefined> {
	if (isBunBinary) return undefined;
	const currentFile = fileURLToPath(import.meta.url);
	const extension = path.extname(currentFile);
	const candidates = [
		path.join(path.dirname(currentFile), `broker-worker${extension}`),
		path.resolve(path.dirname(currentFile), "..", "extensions", "lsp", "broker-worker.js"),
	];
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Try the unbundled dist location next.
		}
	}
	return undefined;
}

async function startWorker(identity: LspBrokerIdentity): Promise<boolean> {
	const worker = await workerPath();
	if (!worker) return false;
	const encoded = Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
	const child = spawn(process.execPath, [worker, encoded], {
		cwd: identity.projectRoot,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		shell: false,
	});
	child.unref();
	return true;
}

export interface SharedBrokerSocket {
	socket: Socket;
	endpoint: string;
}

export async function connectSharedBroker(
	identity: LspBrokerIdentity,
	options: LspBrokerClientOptions = {},
): Promise<SharedBrokerSocket | undefined> {
	if (options.enabled === false) return undefined;
	const endpoint = options.endpoint ?? lspBrokerEndpoint(identity);
	const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	try {
		const health = await probe(endpoint, Math.min(100, connectTimeoutMs));
		if (health.cacheKey !== identity.cacheKey) return undefined;
		return { socket: await connectSocket(endpoint, connectTimeoutMs), endpoint };
	} catch {
		if (options.autoStart === false || !(await startWorker(identity))) return undefined;
	}

	const deadline = Date.now() + connectTimeoutMs;
	while (Date.now() < deadline) {
		try {
			const health = await probe(endpoint, Math.min(100, Math.max(1, deadline - Date.now())));
			if (health.cacheKey !== identity.cacheKey) return undefined;
			return { socket: await connectSocket(endpoint, Math.max(1, deadline - Date.now())), endpoint };
		} catch {
			await new Promise<void>((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
		}
	}
	return undefined;
}

export async function reloadSharedBroker(
	identity: LspBrokerIdentity,
	options: LspBrokerClientOptions = {},
): Promise<boolean> {
	if (options.enabled === false) return false;
	const endpoint = options.endpoint ?? lspBrokerEndpoint(identity);
	let socket: Socket | undefined;
	try {
		socket = await connectSocket(endpoint, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
		const connection = createMessageConnection(
			new StreamMessageReader(socket),
			new StreamMessageWriter(socket),
			logger(),
		);
		connection.listen();
		try {
			await connection.sendRequest(LSP_BROKER_CONNECT_METHOD, identity);
			await connection.sendRequest(LSP_BROKER_RELOAD_METHOD);
			return true;
		} finally {
			connection.dispose();
		}
	} catch {
		return false;
	} finally {
		socket?.destroy();
	}
}
