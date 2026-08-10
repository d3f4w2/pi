import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { DapTransport, DebugAdapterRequest } from "./types.ts";

const ADAPTER_START_TIMEOUT_MS = 7_000;
const PROCESS_ATTACH_TIMEOUT_MS = 15_000;
const SENSITIVE_ENVIRONMENT = /(api.?key|token|secret|password|credential|authorization|auth$)/i;

export interface LaunchedAdapter {
	transport: DapTransport;
	adapterId: string;
	request: "launch" | "attach";
	launchArguments: Record<string, unknown>;
}

interface PythonCommand {
	command: string;
	prefix: string[];
}

export function sanitizedDebugEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(environment).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string" && !SENSITIVE_ENVIRONMENT.test(entry[0]),
		),
	);
}

class StreamTransport implements DapTransport {
	private readonly writable: Writable;
	private readonly cleanup: () => Promise<void>;
	private dataListeners: Array<(data: Uint8Array) => void> = [];
	private closeListeners: Array<(error?: Error) => void> = [];
	private closed = false;

	constructor(readable: Readable, writable: Writable, cleanup: () => Promise<void>) {
		this.writable = writable;
		this.cleanup = cleanup;
		readable.on("data", (chunk: Buffer | string) => {
			const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			for (const listener of this.dataListeners) listener(data);
		});
		readable.once("end", () => this.close());
		readable.once("error", (error) => this.close(error));
	}

	write(data: Uint8Array): void {
		if (this.closed) throw new Error("DAP 连接已经关闭。");
		this.writable.write(Buffer.from(data));
	}

	onData(listener: (data: Uint8Array) => void): void {
		this.dataListeners.push(listener);
	}

	onClose(listener: (error?: Error) => void): void {
		this.closeListeners.push(listener);
	}

	private close(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const listener of this.closeListeners) listener(error);
		this.dataListeners = [];
		this.closeListeners = [];
	}

	async dispose(): Promise<void> {
		this.close();
		await this.cleanup();
	}
}

function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.killed) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, 1_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill();
	});
}

function processTransport(child: ChildProcessWithoutNullStreams): DapTransport {
	return new StreamTransport(child.stdout, child.stdin, () => stopProcess(child));
}

function socketTransport(socket: Socket, child: ChildProcessWithoutNullStreams): DapTransport {
	return new StreamTransport(socket, socket, async () => {
		socket.destroy();
		await stopProcess(child);
	});
}

async function probe(command: string, args: string[], cwd: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			env: sanitizedDebugEnvironment(process.env),
			stdio: "ignore",
			windowsHide: true,
		});
		const timer = setTimeout(() => {
			child.kill();
			resolve(false);
		}, 2_000);
		child.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
}

function pythonCandidates(cwd: string): PythonCommand[] {
	const configured = process.env.PI_PYTHON?.trim();
	const virtualEnvironment =
		process.platform === "win32"
			? path.join(cwd, ".venv", "Scripts", "python.exe")
			: path.join(cwd, ".venv", "bin", "python");
	return [
		...(configured ? [{ command: configured, prefix: [] }] : []),
		...(existsSync(virtualEnvironment) ? [{ command: virtualEnvironment, prefix: [] }] : []),
		{ command: "python", prefix: [] },
		{ command: "python3", prefix: [] },
		...(process.platform === "win32" ? [{ command: "py", prefix: ["-3"] }] : []),
	];
}

async function availableLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("无法为 Python 调试分配本地端口。"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

async function injectPythonDebugServer(candidate: PythonCommand, cwd: string, processId: number): Promise<number> {
	const port = await availableLoopbackPort();
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			candidate.command,
			[...candidate.prefix, "-u", "-m", "debugpy", "--listen", `127.0.0.1:${port}`, "--pid", String(processId)],
			{
				cwd,
				env: sanitizedDebugEnvironment(process.env),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let output = "";
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const collect = (chunk: Buffer): void => {
			output = `${output}${chunk.toString("utf8")}`.slice(-4_000);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", (error) => finish(error));
		child.once("exit", (code) => {
			if (code === 0) finish();
			else
				finish(
					new Error(
						`无法附加到 Python 进程 ${processId}：${output.trim() || `debugpy 退出码 ${code ?? "unknown"}`}`,
					),
				);
		});
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error(`附加到 Python 进程 ${processId} 超时。请确认进程权限和 debugpy 安装。`));
		}, PROCESS_ATTACH_TIMEOUT_MS);
	});
	return port;
}

async function launchPython(request: DebugAdapterRequest): Promise<LaunchedAdapter> {
	for (const candidate of pythonCandidates(request.cwd)) {
		if (!(await probe(candidate.command, [...candidate.prefix, "-c", "import debugpy"], request.cwd))) continue;
		const injectedPort =
			request.mode === "attach" && request.processId !== undefined
				? await injectPythonDebugServer(candidate, request.cwd, request.processId)
				: undefined;
		const child = spawn(candidate.command, [...candidate.prefix, "-u", "-m", "debugpy.adapter"], {
			cwd: request.cwd,
			env: sanitizedDebugEnvironment(process.env),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stderr.on("data", (_chunk: Buffer) => {});
		return {
			transport: processTransport(child),
			adapterId: "debugpy",
			request: request.mode,
			launchArguments: {
				name: request.mode === "launch" ? "Pi Python Debug" : "Pi Python Attach",
				type: "debugpy",
				request: request.mode,
				...(request.mode === "launch"
					? { program: request.path, args: request.args, stopOnEntry: request.stopOnEntry }
					: {
							connect: {
								host: injectedPort === undefined ? (request.host ?? "127.0.0.1") : "127.0.0.1",
								port: injectedPort ?? request.port,
							},
						}),
				cwd: request.cwd,
				console: "internalConsole",
				justMyCode: false,
				env: sanitizedDebugEnvironment(process.env),
			},
		};
	}
	throw new Error("Python 调试需要 debugpy。请运行：pip install debugpy");
}

function knownJsDebugPaths(): string[] {
	const configured = process.env.PI_JS_DEBUG_PATH?.trim();
	const candidates = configured ? [configured] : [];
	const extensionRoot = path.join(homedir(), ".vscode", "extensions");
	try {
		for (const directory of readdirSync(extensionRoot)) {
			if (!directory.startsWith("ms-vscode.js-debug")) continue;
			candidates.push(
				path.join(extensionRoot, directory, "src", "dapDebugServer.js"),
				path.join(extensionRoot, directory, "dist", "src", "dapDebugServer.js"),
			);
		}
	} catch {
		// VS Code extensions are optional.
	}
	if (process.env.LOCALAPPDATA) {
		candidates.push(
			path.join(
				process.env.LOCALAPPDATA,
				"Programs",
				"Microsoft VS Code",
				"resources",
				"app",
				"extensions",
				"ms-vscode.js-debug",
				"src",
				"dapDebugServer.js",
			),
		);
	}
	return [...new Set(candidates)].filter(existsSync);
}

async function connectTcpAdapter(
	command: string,
	args: string[],
	cwd: string,
	portPattern: RegExp,
): Promise<{ transport: DapTransport; child: ChildProcessWithoutNullStreams }> {
	const child = spawn(command, args, {
		cwd,
		env: sanitizedDebugEnvironment(process.env),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let port: number;
	try {
		port = await new Promise<number>((resolve, reject) => {
			let output = "";
			const timer = setTimeout(() => reject(new Error("调试适配器启动超时。")), ADAPTER_START_TIMEOUT_MS);
			const consume = (chunk: Buffer): void => {
				output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
				const match = portPattern.exec(output);
				const value = Number.parseInt(match?.[1] ?? "", 10);
				if (!Number.isInteger(value) || value < 1 || value > 65_535) return;
				clearTimeout(timer);
				resolve(value);
			};
			child.stdout.on("data", consume);
			child.stderr.on("data", consume);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`调试适配器启动失败：${code ?? "unknown"}`));
			});
		});
		const socket = await new Promise<Socket>((resolve, reject) => {
			const connection = createConnection({ host: "127.0.0.1", port }, () => resolve(connection));
			connection.once("error", reject);
		});
		return { transport: socketTransport(socket, child), child };
	} catch (error) {
		await stopProcess(child);
		throw error;
	}
}

async function launchJavascript(request: DebugAdapterRequest): Promise<LaunchedAdapter> {
	const adapterPath = knownJsDebugPaths()[0];
	if (!adapterPath) {
		throw new Error(
			"JavaScript/TypeScript 调试需要 vscode-js-debug。安装后设置 PI_JS_DEBUG_PATH 指向 dapDebugServer.js。",
		);
	}
	const { transport } = await connectTcpAdapter(process.execPath, [adapterPath], request.cwd, /^\s*(\d{2,5})\s*$/m);
	const extension = request.path ? path.extname(request.path).toLowerCase() : "";
	return {
		transport,
		adapterId: "pwa-node",
		request: request.mode,
		launchArguments: {
			name: request.mode === "launch" ? "Pi JavaScript Debug" : "Pi JavaScript Attach",
			type: "pwa-node",
			request: request.mode,
			...(request.mode === "launch"
				? { program: request.path, args: request.args }
				: request.processId !== undefined
					? { processId: request.processId }
					: { address: request.host ?? "127.0.0.1", port: request.port }),
			cwd: request.cwd,
			runtimeExecutable: process.execPath,
			...(request.mode === "launch" && (extension === ".ts" || extension === ".mts" || extension === ".cts")
				? { runtimeArgs: ["--experimental-strip-types"] }
				: {}),
			console: "internalConsole",
			...(request.mode === "launch" ? { stopOnEntry: request.stopOnEntry } : {}),
			env: sanitizedDebugEnvironment(process.env),
		},
	};
}

async function launchGo(request: DebugAdapterRequest): Promise<LaunchedAdapter> {
	if (!(await probe("dlv", ["version"], request.cwd))) {
		throw new Error("Go 调试需要 Delve。请运行：go install github.com/go-delve/delve/cmd/dlv@latest");
	}
	const { transport } = await connectTcpAdapter(
		"dlv",
		["dap", "--listen=127.0.0.1:0"],
		request.cwd,
		/DAP server listening at:\s*127\.0\.0\.1:(\d+)/i,
	);
	return {
		transport,
		adapterId: "go",
		request: request.mode,
		launchArguments: {
			name: request.mode === "launch" ? "Pi Go Debug" : "Pi Go Attach",
			type: "go",
			request: request.mode,
			...(request.mode === "launch"
				? { mode: "debug", program: request.path, args: request.args, stopOnEntry: request.stopOnEntry }
				: { mode: "local", processId: request.processId }),
			cwd: request.cwd,
			env: sanitizedDebugEnvironment(process.env),
		},
	};
}

export async function launchDebugAdapter(request: DebugAdapterRequest): Promise<LaunchedAdapter> {
	if (request.language === "python") return launchPython(request);
	if (request.language === "go") return launchGo(request);
	return launchJavascript(request);
}
