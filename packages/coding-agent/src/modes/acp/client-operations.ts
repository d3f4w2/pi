import type {
	ClientCapabilities,
	CreateTerminalRequest,
	ReadTextFileRequest,
	ReadTextFileResponse,
	TerminalOutputResponse,
	WaitForTerminalExitResponse,
	WriteTextFileRequest,
	WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { type BashOperations, type BashToolExecutor, createBashToolDefinition } from "../../core/tools/bash.ts";
import { createEditToolDefinition } from "../../core/tools/edit.ts";
import { createReadToolDefinition } from "../../core/tools/read.ts";
import { DEFAULT_MAX_BYTES } from "../../core/tools/truncate.ts";
import { createWriteToolDefinition } from "../../core/tools/write.ts";
import { getPowerShellConfig, getShellConfig } from "../../utils/shell.ts";

// A host-mode override registry is intentionally heterogeneous across each tool's schema, details, and render state.
type AcpToolDefinition = ToolDefinition<any, any, any>;

interface AcpTerminalHandle {
	id: string;
	currentOutput(): Promise<TerminalOutputResponse>;
	waitForExit(): Promise<WaitForTerminalExitResponse>;
	kill(): Promise<unknown>;
	release(): Promise<unknown>;
}

export interface AcpClientOperations {
	readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
	// biome-ignore lint/suspicious/noConfusingVoidType: ACP clients may omit the response body entirely.
	writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse | void>;
	createTerminal(params: CreateTerminalRequest): Promise<AcpTerminalHandle>;
}

function validateTextResponse(response: ReadTextFileResponse): string {
	if (!response || typeof response.content !== "string") {
		throw new Error("ACP client returned an invalid fs/read_text_file response.");
	}
	return response.content;
}

function shellInvocation(command: string, executor: BashToolExecutor | undefined): { command: string; args: string[] } {
	const selected = executor ?? (process.platform === "win32" ? "powershell" : "bash");
	const config = selected === "powershell" ? getPowerShellConfig() : getShellConfig();
	const args = [...config.args];
	if (config.commandTransport === "stdin" && args.at(-1) === "-") args[args.length - 1] = command;
	else args.push(command);
	return { command: config.shell, args };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAcpBashOperations(client: AcpClientOperations, sessionId: string): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, executor }) {
			if (signal?.aborted) throw new Error("aborted");
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				throw new Error("Invalid timeout: must be a finite number of seconds");
			}
			const invocation = shellInvocation(command, executor);
			const terminal = await client.createTerminal({
				sessionId,
				command: invocation.command,
				args: invocation.args,
				cwd,
				outputByteLimit: DEFAULT_MAX_BYTES,
			});
			let previousOutput = "";
			let timedOut = false;
			let aborted = false;
			let killPromise: Promise<unknown> | undefined;
			const kill = () => {
				killPromise ??= terminal.kill().catch(() => undefined);
			};
			const abort = () => {
				aborted = true;
				kill();
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			const timeoutHandle =
				timeout === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							kill();
						}, timeout * 1000);
			const emitCurrentOutput = async (): Promise<void> => {
				const snapshot = await terminal.currentOutput();
				if (!snapshot || typeof snapshot.output !== "string") {
					throw new Error("ACP client returned an invalid terminal/output response.");
				}
				const delta = snapshot.output.startsWith(previousOutput)
					? snapshot.output.slice(previousOutput.length)
					: snapshot.output;
				previousOutput = snapshot.output;
				if (delta) onData(Buffer.from(delta, "utf8"));
			};

			try {
				let settled = false;
				const wait = terminal.waitForExit();
				void wait
					.finally(() => {
						settled = true;
					})
					.catch(() => undefined);
				while (!settled) {
					await Promise.race([wait, delay(100)]);
					if (!settled) await emitCurrentOutput();
				}
				const status = await wait;
				await emitCurrentOutput();
				if (killPromise) await killPromise;
				if (aborted || signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode: status.exitCode ?? null };
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				signal?.removeEventListener("abort", abort);
				await terminal.release();
			}
		},
	};
}

export function createAcpToolDefinitionOverrides(
	cwd: string,
	sessionId: string,
	capabilities: ClientCapabilities | undefined,
	client: AcpClientOperations,
): Record<string, AcpToolDefinition> {
	const overrides: Record<string, AcpToolDefinition> = {};
	const canRead = capabilities?.fs?.readTextFile === true;
	const canWrite = capabilities?.fs?.writeTextFile === true;
	const readTextFile = async (path: string): Promise<string> =>
		validateTextResponse(await client.readTextFile({ sessionId, path }));

	if (canRead) {
		overrides.read = createReadToolDefinition(cwd, {
			operations: {
				access: async () => {},
				readFile: async (path) => Buffer.from(await readTextFile(path), "utf8"),
			},
		});
	}
	if (canWrite) {
		overrides.write = createWriteToolDefinition(cwd, {
			operations: {
				...(canRead ? { readFile: readTextFile } : {}),
				mkdir: async () => {},
				writeFile: async (path, content) => {
					await client.writeTextFile({ sessionId, path, content });
				},
			},
		});
	}
	if (canRead && canWrite) {
		const writeFile = async (path: string, content: string): Promise<void> => {
			await client.writeTextFile({ sessionId, path, content });
		};
		overrides.edit = createEditToolDefinition(cwd, {
			operations: {
				access: async () => {},
				readFile: async (path) => Buffer.from(await readTextFile(path), "utf8"),
				writeFile,
				replaceFile: writeFile,
			},
		});
	}
	if (capabilities?.terminal === true) {
		overrides.bash = createBashToolDefinition(cwd, {
			operations: createAcpBashOperations(client, sessionId),
			exposeSessionEnvironment: false,
		});
	}
	return overrides;
}
