import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { reloadSharedBroker } from "../src/extensions/lsp/broker-client.ts";
import {
	LSP_BROKER_CONNECT_METHOD,
	LSP_BROKER_HEALTH_METHOD,
	type LspBrokerHealth,
	type LspBrokerIdentity,
	lspBrokerEndpoint,
	lspBrokerIdentity,
} from "../src/extensions/lsp/broker-protocol.ts";
import { LspBrokerServer } from "../src/extensions/lsp/broker-server.ts";
import { startLanguageClient } from "../src/extensions/lsp/client.ts";
import type { LanguageAdapter, LanguageServerLaunch, LspClient } from "../src/extensions/lsp/types.ts";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-lsp-server.mjs", import.meta.url));
const tempDirectories: string[] = [];
const brokers: LspBrokerServer[] = [];
const clients: LspClient[] = [];

async function createProject(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-lsp-broker-"));
	tempDirectories.push(directory);
	return realpath(directory);
}

function launch(counterPath: string, delayMs = 0, failInitialize = false): LanguageServerLaunch {
	return {
		command: process.execPath,
		args: [
			fakeServer,
			"--counter",
			counterPath,
			"--delay",
			String(delayMs),
			...(failInitialize ? ["--fail-initialize"] : []),
		],
	};
}

function adapter(serverLaunch: LanguageServerLaunch): LanguageAdapter {
	return {
		id: "typescript",
		displayName: "Fake TypeScript",
		extensions: [".ts"],
		rootMarkers: ["package.json"],
		languageId: () => "typescript",
		launchCandidates: () => [serverLaunch],
	};
}

async function startBroker(
	projectRoot: string,
	serverLaunch: LanguageServerLaunch,
	options: { idleTimeoutMs?: number; negativeCacheMs?: number } = {},
): Promise<{ broker: LspBrokerServer; identity: LspBrokerIdentity; endpoint: string }> {
	const identity = lspBrokerIdentity(projectRoot, "typescript", serverLaunch);
	const endpoint = lspBrokerEndpoint(identity);
	const broker = new LspBrokerServer({ identity, endpoint, ...options });
	brokers.push(broker);
	await broker.listen();
	return { broker, identity, endpoint };
}

function connectSocket(endpoint: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(endpoint);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

async function rpcConnection(endpoint: string): Promise<{ socket: Socket; connection: MessageConnection }> {
	const socket = await connectSocket(endpoint);
	const connection = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket), {
		error: () => {},
		warn: () => {},
		info: () => {},
		log: () => {},
	});
	connection.listen();
	return { socket, connection };
}

async function counterPids(counterPath: string): Promise<number[]> {
	try {
		return (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean).map(Number);
	} catch {
		return [];
	}
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => {})));
	await Promise.all(brokers.splice(0).map((broker) => broker.close().catch(() => {})));
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
	);
});

describe("local LSP broker", () => {
	test("makes a second session at least 50% faster and keeps one server process", async () => {
		const project = await createProject();
		const counter = path.join(project, "starts.txt");
		const source = path.join(project, "index.ts");
		await writeFile(source, "const value = 1;\n", "utf8");
		const serverLaunch = launch(counter, 180);
		const { endpoint } = await startBroker(project, serverLaunch);
		const language = adapter(serverLaunch);

		const coldStarted = performance.now();
		const first = await startLanguageClient(language, project, {
			broker: { endpoint, autoStart: false },
			startupTimeoutMs: 2_000,
		});
		clients.push(first);
		await first.openDocument(source);
		const coldMs = performance.now() - coldStarted;
		const sharedStarted = performance.now();
		const second = await startLanguageClient(language, project, {
			broker: { endpoint, autoStart: false },
			startupTimeoutMs: 2_000,
		});
		clients.push(second);
		await second.openDocument(source);
		const sharedMs = performance.now() - sharedStarted;
		const sharedSamples = [sharedMs];
		for (let index = 0; index < 19; index++) {
			const sampleStarted = performance.now();
			const sample = await startLanguageClient(language, project, {
				broker: { endpoint, autoStart: false },
				startupTimeoutMs: 2_000,
			});
			clients.push(sample);
			sharedSamples.push(performance.now() - sampleStarted);
		}
		const sortedSamples = sharedSamples.slice().sort((left, right) => left - right);
		const p50 = sortedSamples[Math.floor((sortedSamples.length - 1) * 0.5)] ?? 0;
		const p95 = sortedSamples[Math.floor((sortedSamples.length - 1) * 0.95)] ?? 0;
		const languageServerRss = await second.rawRequest("pi/test/memory", undefined);

		expect(first.transportKind).toBe("shared");
		expect(second.transportKind).toBe("shared");
		expect(second.languageServerPid).toBe(first.languageServerPid);
		expect(new Set(await counterPids(counter))).toHaveLength(1);
		expect(sharedMs).toBeLessThan(coldMs * 0.5);
		expect(p50).toBeLessThan(coldMs * 0.5);
		expect(p95).toBeLessThan(coldMs * 0.5);
		expect(languageServerRss).toEqual(expect.any(Number));
		await first.stop();
		const hover = await second.hover(await second.openDocument(source), { line: 0, character: 6 });
		expect(hover).toMatchObject({ contents: { value: "fake hover" } });
	});

	test("initializes once under concurrent connections", async () => {
		const project = await createProject();
		const counter = path.join(project, "starts.txt");
		const serverLaunch = launch(counter, 100);
		const { endpoint } = await startBroker(project, serverLaunch);
		const language = adapter(serverLaunch);

		const concurrent = await Promise.all(
			Array.from({ length: 4 }, () =>
				startLanguageClient(language, project, {
					broker: { endpoint, autoStart: false },
					startupTimeoutMs: 2_000,
				}),
			),
		);
		clients.push(...concurrent);

		expect(new Set(concurrent.map((client) => client.languageServerPid))).toHaveLength(1);
		expect(new Set(await counterPids(counter))).toHaveLength(1);
	});

	test("rejects cross-project sharing and falls back to a private server", async () => {
		const firstProject = await createProject();
		const secondProject = await createProject();
		const counter = path.join(firstProject, "starts.txt");
		const serverLaunch = launch(counter);
		const { endpoint } = await startBroker(firstProject, serverLaunch);
		const client = await startLanguageClient(adapter(serverLaunch), secondProject, {
			broker: { endpoint, autoStart: false },
			startupTimeoutMs: 2_000,
		});
		clients.push(client);

		expect(client.transportKind).toBe("private");
		expect(client.languageServerPid).not.toBe(brokers[0]?.health().languageServerPid);
	});

	test("falls back to a private server after the broker server crashes", async () => {
		const project = await createProject();
		const counter = path.join(project, "starts.txt");
		const source = path.join(project, "index.ts");
		await writeFile(source, "const value = 1;\n", "utf8");
		const serverLaunch = launch(counter);
		const { endpoint } = await startBroker(project, serverLaunch);
		const client = await startLanguageClient(adapter(serverLaunch), project, {
			broker: { endpoint, autoStart: false },
			startupTimeoutMs: 2_000,
		});
		clients.push(client);
		const sharedPid = client.languageServerPid;
		if (!sharedPid) throw new Error("fake shared server has no pid");
		process.kill(sharedPid);
		await new Promise<void>((resolve) => setTimeout(resolve, 40));

		const started = performance.now();
		const hover = await client.hover(await client.openDocument(source), { line: 0, character: 6 });
		const fallbackMs = performance.now() - started;

		expect(hover).toMatchObject({ contents: { value: "fake hover" } });
		expect(client.transportKind).toBe("private");
		expect(client.languageServerPid).not.toBe(sharedPid);
		if (process.env.PI_TEST_PERFORMANCE === "1") expect(fallbackMs).toBeLessThan(1_000);
	});

	test("caches initialization failures and exposes health", async () => {
		const project = await createProject();
		const counter = path.join(project, "starts.txt");
		const serverLaunch = launch(counter, 0, true);
		const { identity, endpoint } = await startBroker(project, serverLaunch, { negativeCacheMs: 2_000 });
		const first = await rpcConnection(endpoint);
		const second = await rpcConnection(endpoint);
		try {
			await first.connection.sendRequest(LSP_BROKER_CONNECT_METHOD, identity);
			await second.connection.sendRequest(LSP_BROKER_CONNECT_METHOD, identity);
			await expect(first.connection.sendRequest("initialize", {})).rejects.toThrow("injected initialize failure");
			await expect(second.connection.sendRequest("initialize", {})).rejects.toThrow("injected initialize failure");
			const health = await second.connection.sendRequest<LspBrokerHealth>(LSP_BROKER_HEALTH_METHOD);
			expect(health).toMatchObject({ status: "failed", clientCount: 2 });
			expect(health.negativeCacheUntil).toBeGreaterThan(Date.now());
			expect(new Set(await counterPids(counter))).toHaveLength(1);
			expect(await reloadSharedBroker(identity, { endpoint, autoStart: false })).toBe(true);
		} finally {
			first.connection.dispose();
			first.socket.destroy();
			second.connection.dispose();
			second.socket.destroy();
		}
	});

	test("times out shared initialization, then bounds the private fallback", async () => {
		const project = await createProject();
		const counter = path.join(project, "starts.txt");
		const serverLaunch = launch(counter, 300);
		const { endpoint } = await startBroker(project, serverLaunch);
		const started = performance.now();

		await expect(
			startLanguageClient(adapter(serverLaunch), project, {
				broker: { endpoint, autoStart: false },
				startupTimeoutMs: 50,
			}),
		).rejects.toThrow("超过 50ms");
		expect(performance.now() - started).toBeLessThan(500);
	});
});
