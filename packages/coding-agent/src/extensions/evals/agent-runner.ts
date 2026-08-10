import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionStats } from "../../core/agent-session.ts";
import type { JsonAgentSessionEvent } from "../../modes/json-event.ts";
import { RpcClient, type RpcClientOptions } from "../../modes/rpc/rpc-client.ts";
import type {
	AgentEvalCase,
	AgentEvalResult,
	AgentEvalRunnerLike,
	AgentEvalRunOptions,
	AgentEvalTiming,
	AgentEvalTraceEntry,
} from "./types.ts";

const EVAL_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"code_search",
	"lsp",
	"ast_grep",
	"verify",
]);
const MAX_VERIFIER_OUTPUT = 2_000;
const MAX_TRACE_ENTRIES = 40;
const MAX_TRACE_SUMMARY = 180;
const TOOL_INPUT_KEYS = ["path", "file", "query", "pattern", "symbol", "operation", "command", "scope", "language"];

export interface AgentEvalClient {
	start(): Promise<void>;
	onEvent(listener: (event: JsonAgentSessionEvent) => void): () => void;
	promptAndWait(message: string, images?: undefined, timeout?: number): Promise<JsonAgentSessionEvent[]>;
	getSessionStats(): Promise<SessionStats>;
	abort(): Promise<void>;
	stop(): Promise<void>;
}

export type AgentEvalClientFactory = (options: RpcClientOptions) => AgentEvalClient;

function cliPath(): string {
	const extension = path.extname(fileURLToPath(import.meta.url)) === ".ts" ? ".ts" : ".js";
	return fileURLToPath(new URL(`../../cli${extension}`, import.meta.url));
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const destination = path.resolve(root, relativePath);
		const relative = path.relative(root, destination);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Unsafe evaluation file path: ${relativePath}`);
		}
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, content, "utf8");
	}
}

function runVerifier(cwd: string, verifierPath: string, timeoutMs: number): Promise<{ code: number; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--test", verifierPath], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const append = (chunk: Buffer): void => {
			if (output.length < MAX_VERIFIER_OUTPUT) output += chunk.toString("utf8");
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, output: output.slice(0, MAX_VERIFIER_OUTPUT).trim() });
		});
	});
}

function countToolErrors(events: JsonAgentSessionEvent[]): number {
	let errors = 0;
	for (const event of events) {
		if (event.type !== "agent_end") continue;
		for (const message of event.messages) {
			if (message.role === "toolResult" && message.isError) errors++;
		}
	}
	return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactSummary(value: string): string {
	const redacted = value
		.replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^\s,"']+/gi, "$1=[redacted]")
		.replace(/\b(?:sk|pk)-[a-z0-9_-]{8,}\b/gi, "[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	return redacted.length <= MAX_TRACE_SUMMARY ? redacted : `${redacted.slice(0, MAX_TRACE_SUMMARY - 1)}…`;
}

function valueSummary(value: unknown): string | undefined {
	if (typeof value === "string") return compactSummary(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return compactSummary(value.join(", "));
	}
	return undefined;
}

function summarizeToolInput(args: unknown): string | undefined {
	if (!isRecord(args)) return valueSummary(args);
	const fields: string[] = [];
	for (const key of TOOL_INPUT_KEYS) {
		const summary = valueSummary(args[key]);
		if (summary) fields.push(`${key}=${summary}`);
	}
	for (const key of ["content", "text", "newText"]) {
		const value = args[key];
		if (typeof value === "string") fields.push(`${key}=${Buffer.byteLength(value, "utf8")} bytes`);
	}
	return fields.length > 0 ? compactSummary(fields.join(" · ")) : undefined;
}

function textFromContent(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const text = value.flatMap((item) => (isRecord(item) && typeof item.text === "string" ? [item.text] : [])).join(" ");
	return text || undefined;
}

function summarizeToolResult(result: unknown): string | undefined {
	if (typeof result === "string") return compactSummary(result);
	if (!isRecord(result)) return undefined;
	const content = textFromContent(result.content);
	if (content) return compactSummary(content);
	for (const key of ["stdout", "stderr", "output", "message"]) {
		const value = result[key];
		if (typeof value === "string" && value.trim()) return compactSummary(value);
	}
	return undefined;
}

function summarizeAssistant(events: JsonAgentSessionEvent[]): string | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (event?.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") continue;
		const text = textFromContent(event.message.content);
		if (text) return compactSummary(text);
	}
	return undefined;
}

export class IsolatedAgentEvalRunner implements AgentEvalRunnerLike {
	private readonly createClient: AgentEvalClientFactory;

	constructor(createClient: AgentEvalClientFactory = (options) => new RpcClient(options)) {
		this.createClient = createClient;
	}

	async run(testCase: AgentEvalCase, options: AgentEvalRunOptions, signal?: AbortSignal): Promise<AgentEvalResult> {
		const startedAt = Date.now();
		const workspace = await mkdtemp(path.join(tmpdir(), `pi-go-eval-${testCase.id}-`));
		const client = this.createClient({
			cliPath: cliPath(),
			cwd: workspace,
			provider: options.provider,
			model: options.model,
			args: [
				"--thinking",
				options.thinkingLevel,
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--approve",
				"--tools",
				options.tools.filter((tool) => EVAL_TOOLS.has(tool)).join(",") || "read,bash,edit,write,grep",
				"--append-system-prompt",
				"This is a bounded capability evaluation. Work only inside the current fixture, avoid broad searches, verify the requested result, and stop when the task is complete.",
			],
		});
		let events: JsonAgentSessionEvent[] = [];
		let totalTokens = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let toolCalls = 0;
		let observedToolCalls = 0;
		let timedOut = false;
		let verificationPassed = false;
		let budgetPassed = false;
		let failure: string | undefined;
		let result: AgentEvalResult | undefined;
		const trace: AgentEvalTraceEntry[] = [];
		const timing: AgentEvalTiming = {
			preparingMs: 0,
			startupMs: 0,
			agentMs: 0,
			verificationMs: 0,
			cleanupMs: 0,
		};
		const pendingTools = new Map<string, { startedAt: number; entry?: AgentEvalTraceEntry }>();
		let unsubscribe = (): void => {};
		const recordPhase = (
			name: string,
			phaseStartedAt: number,
			status: AgentEvalTraceEntry["status"],
			output?: string,
		): void => {
			if (trace.length >= MAX_TRACE_ENTRIES) return;
			trace.push({
				kind: "phase",
				name,
				startedAtMs: phaseStartedAt - startedAt,
				durationMs: Date.now() - phaseStartedAt,
				status,
				...(output ? { output: compactSummary(output) } : {}),
			});
		};
		const abort = (): void => {
			void client.abort().catch(() => {});
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			options.onProgress?.({ stage: "preparing", toolCalls: 0 });
			const preparingStartedAt = Date.now();
			try {
				await writeFiles(workspace, testCase.publicFiles);
				timing.preparingMs = Date.now() - preparingStartedAt;
				recordPhase("preparing", preparingStartedAt, "passed");
			} catch (error) {
				timing.preparingMs = Date.now() - preparingStartedAt;
				recordPhase(
					"preparing",
					preparingStartedAt,
					"failed",
					error instanceof Error ? error.message : String(error),
				);
				throw error;
			}
			options.onProgress?.({ stage: "starting", toolCalls: 0 });
			const startupStartedAt = Date.now();
			try {
				await client.start();
				timing.startupMs = Date.now() - startupStartedAt;
				recordPhase("starting", startupStartedAt, "passed");
			} catch (error) {
				timing.startupMs = Date.now() - startupStartedAt;
				recordPhase("starting", startupStartedAt, "failed", error instanceof Error ? error.message : String(error));
				throw error;
			}
			unsubscribe = client.onEvent((event) => {
				if (event.type === "tool_execution_start") {
					observedToolCalls++;
					const toolStartedAt = Date.now();
					const input = summarizeToolInput(event.args);
					const entry: AgentEvalTraceEntry | undefined =
						trace.length < MAX_TRACE_ENTRIES
							? {
									kind: "tool",
									name: event.toolName,
									startedAtMs: toolStartedAt - startedAt,
									durationMs: 0,
									status: "running",
									...(input ? { input } : {}),
								}
							: undefined;
					if (entry) trace.push(entry);
					pendingTools.set(event.toolCallId, { startedAt: toolStartedAt, ...(entry ? { entry } : {}) });
					options.onProgress?.({
						stage: "tool",
						toolName: event.toolName,
						toolCalls: observedToolCalls,
						...(input ? { detail: input } : {}),
					});
					return;
				}
				if (event.type !== "tool_execution_end") return;
				const pending = pendingTools.get(event.toolCallId);
				const output = summarizeToolResult(event.result);
				if (pending?.entry) {
					pending.entry.durationMs = Date.now() - pending.startedAt;
					pending.entry.status = event.isError ? "failed" : "passed";
					if (output) pending.entry.output = output;
				}
				pendingTools.delete(event.toolCallId);
				options.onProgress?.({
					stage: "tool",
					toolName: event.toolName,
					toolCalls: observedToolCalls,
					detail: `${event.isError ? "✗" : "✓"} ${output ?? "completed"}`,
				});
			});
			options.onProgress?.({ stage: "working", toolCalls: 0 });
			const agentStartedAt = Date.now();
			try {
				events = await client.promptAndWait(testCase.task, undefined, testCase.timeoutMs);
			} catch (error) {
				timedOut = error instanceof Error && error.message.includes("Timeout");
				failure = timedOut ? "Agent evaluation timed out" : error instanceof Error ? error.message : String(error);
				abort();
			}
			timing.agentMs = Date.now() - agentStartedAt;
			recordPhase("working", agentStartedAt, failure ? "failed" : "passed", failure);
			try {
				const stats = await client.getSessionStats();
				totalTokens = stats.tokens.total;
				inputTokens = stats.tokens.input;
				outputTokens = stats.tokens.output;
				cacheReadTokens = stats.tokens.cacheRead;
				toolCalls = Math.max(stats.toolCalls, observedToolCalls);
			} catch {
				// The child may already be unavailable after a crash or timeout.
				toolCalls = observedToolCalls;
			}
			await client.stop();
			if (!failure) {
				options.onProgress?.({ stage: "verifying", toolCalls });
				const verificationStartedAt = Date.now();
				try {
					await writeFiles(workspace, testCase.hiddenFiles);
					const verifierPath = Object.keys(testCase.hiddenFiles)[0];
					if (!verifierPath) throw new Error("Evaluation case has no hidden verifier");
					const verification = await runVerifier(workspace, verifierPath, 30_000);
					verificationPassed = verification.code === 0;
					if (!verificationPassed) failure = verification.output || "Hidden verification failed";
					timing.verificationMs = Date.now() - verificationStartedAt;
					recordPhase(
						"verifying",
						verificationStartedAt,
						verificationPassed ? "passed" : "failed",
						verificationPassed ? "Hidden verifier passed" : failure,
					);
				} catch (error) {
					timing.verificationMs = Date.now() - verificationStartedAt;
					recordPhase(
						"verifying",
						verificationStartedAt,
						"failed",
						error instanceof Error ? error.message : String(error),
					);
					throw error;
				}
			}
			budgetPassed = outputTokens <= testCase.maxOutputTokens && toolCalls <= testCase.maxToolCalls;
			if (!failure && !budgetPassed) {
				failure =
					outputTokens > testCase.maxOutputTokens
						? `Output token budget exceeded: ${outputTokens} > ${testCase.maxOutputTokens}`
						: `Tool call budget exceeded: ${toolCalls} > ${testCase.maxToolCalls}`;
			}
			const assistantSummary = summarizeAssistant(events);
			result = {
				version: 1,
				id: randomUUID(),
				caseId: testCase.id,
				title: testCase.title,
				category: testCase.category,
				createdAt: new Date().toISOString(),
				provider: options.provider,
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				passed: failure === undefined,
				verificationPassed,
				budgetPassed,
				timedOut,
				durationMs: Date.now() - startedAt,
				totalTokens,
				inputTokens,
				outputTokens,
				cacheReadTokens,
				toolCalls,
				toolErrors: countToolErrors(events),
				timing,
				trace,
				...(assistantSummary ? { assistantSummary } : {}),
				...(failure ? { failure: failure.slice(0, 500) } : {}),
			};
			return result;
		} finally {
			const cleanupStartedAt = Date.now();
			options.onProgress?.({ stage: "cleanup", toolCalls });
			unsubscribe();
			signal?.removeEventListener("abort", abort);
			await client.stop().catch(() => {});
			await rm(workspace, { recursive: true, force: true });
			timing.cleanupMs = Date.now() - cleanupStartedAt;
			recordPhase("cleanup", cleanupStartedAt, "passed");
			if (result) result.durationMs = Date.now() - startedAt;
		}
	}
}
