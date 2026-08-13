import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config.ts";
import type { VerifyResult } from "../extensions/verify/types.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree } from "../utils/shell.ts";
import { getWorkspaceReceiptPath } from "./project-runs.ts";
import {
	createEffectiveRunContract,
	type EffectiveRunContract,
	hashRunContract,
	parseRunArguments,
	parseRunContractText,
	type RunVerificationContract,
} from "./run-contract.ts";
import { RunEventAccumulator, type RunEventSummary } from "./run-events.ts";
import {
	createRunReceiptEnvelope,
	hashPrivateText,
	type RunOutcome,
	type RunReceipt,
	type RunReceiptEnvelope,
	type RunTerminationReason,
	type RunVerificationEvidence,
	verifyRunReceiptText,
	writeRunReceipt,
} from "./run-receipt.ts";
import {
	compareWorkspaceSnapshots,
	getGitWorkspaceRoot,
	takeWorkspaceSnapshot,
	type WorkspaceSnapshot,
} from "./run-workspace.ts";

const MAX_STDERR_CHARACTERS = 8192;
const MAX_VERIFY_STDOUT_CHARACTERS = 1024 * 1024;

export interface AgentExecutionResult {
	exitCode: number | null;
	terminationReason: RunTerminationReason;
	stderr: string;
	summary: RunEventSummary;
}

export interface RunCommandDependencies {
	cwd: () => string;
	now: () => Date;
	monotonicNow: () => number;
	randomUUID: () => string;
	readTextFile: (filePath: string) => Promise<string>;
	getWorkspaceRoot: (cwd: string) => Promise<string>;
	takeSnapshot: (cwd: string) => Promise<WorkspaceSnapshot>;
	executeAgent: (
		contract: EffectiveRunContract,
		forwardedArgs: readonly string[],
		cwd: string,
	) => Promise<AgentExecutionResult>;
	verify: (verification: RunVerificationContract, cwd: string, maxDurationMs?: number) => Promise<VerifyResult>;
	defaultReceiptPath: (runId: string, workspaceRoot: string) => string;
	assertReceiptTargetAvailable: (receiptPath: string) => Promise<void>;
	writeReceipt: (receiptPath: string, envelope: RunReceiptEnvelope) => Promise<void>;
	writeStdout: (value: string) => void;
	writeStderr: (value: string) => void;
	setExitCode: (value: number) => void;
}

export interface AgentChildOptions {
	execPath?: string;
	entryPath?: string;
	execArgv?: readonly string[];
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

async function assertReceiptTargetAvailable(receiptPath: string): Promise<void> {
	try {
		await access(receiptPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	throw new Error(`回执文件已存在，不会启动任务：${receiptPath}`);
}

function defaultDependencies(): RunCommandDependencies {
	return {
		cwd: () => process.cwd(),
		now: () => new Date(),
		monotonicNow: () => performance.now(),
		randomUUID,
		readTextFile: (filePath) => readFile(filePath, "utf8"),
		getWorkspaceRoot: getGitWorkspaceRoot,
		takeSnapshot: takeWorkspaceSnapshot,
		executeAgent: executeAgentChild,
		verify: executeVerifyChild,
		defaultReceiptPath: (runId, workspaceRoot) => getWorkspaceReceiptPath(getAgentDir(), workspaceRoot, runId),
		assertReceiptTargetAvailable,
		writeReceipt: writeRunReceipt,
		writeStdout: (value) => process.stdout.write(value),
		writeStderr: (value) => process.stderr.write(value),
		setExitCode: (value) => {
			process.exitCode = value;
		},
	};
}

function verifyWorkerPath(): string {
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	return fileURLToPath(new URL(`./run-verify-worker.${extension}`, import.meta.url));
}

function parseVerifyWorkerResponse(text: string): VerifyResult {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("独立验证进程返回了无效 JSON。");
	}
	if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true || !("result" in value)) {
		throw new Error("独立验证进程失败。");
	}
	return value.result as VerifyResult;
}

class RunBudgetTimeoutError extends Error {}

export async function executeVerifyChild(
	verification: RunVerificationContract,
	cwd: string,
	maxDurationMs?: number,
): Promise<VerifyResult> {
	if (maxDurationMs !== undefined && maxDurationMs <= 0) throw new RunBudgetTimeoutError("整体执行预算已耗尽。");
	const execArgv = process.execArgv.filter((argument) => !argument.startsWith("--inspect"));
	const child = spawnProcess(process.execPath, [...execArgv, verifyWorkerPath()], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	let stdout = "";
	let stderr = "";
	child.stdin?.on("error", () => {});
	child.stdin?.end(JSON.stringify({ verification, cwd }), "utf8");
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout = `${stdout}${chunk}`.slice(-MAX_VERIFY_STDOUT_CHARACTERS);
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARACTERS);
	});
	let timedOut = false;
	const workerTimeoutMs = (verification.timeoutSeconds * 3 + 15) * 1000;
	const timeoutMs = Math.min(workerTimeoutMs, maxDurationMs ?? Number.POSITIVE_INFINITY);
	const wholeRunLimited = maxDurationMs !== undefined && maxDurationMs <= workerTimeoutMs;
	const timeout = setTimeout(() => {
		timedOut = true;
		if (child.pid !== undefined) killProcessTree(child.pid);
	}, timeoutMs);
	let exitCode: number | null;
	try {
		exitCode = await waitForChildProcess(child);
	} finally {
		clearTimeout(timeout);
	}
	if (timedOut && wholeRunLimited) throw new RunBudgetTimeoutError("独立验证超过整体执行预算。");
	if (timedOut) throw new Error("独立验证进程超时。");
	if (exitCode !== 0) throw new Error(stderr.trim() || "独立验证进程失败。");
	return parseVerifyWorkerResponse(stdout);
}

function executableArguments(
	options: AgentChildOptions,
	forwardedArgs: readonly string[],
): { command: string; args: string[] } {
	const command = options.execPath ?? process.execPath;
	const entryPath = options.entryPath ?? process.argv[1];
	if (!entryPath) throw new Error("无法确定当前 Pigo CLI 入口。");
	const execArgv = (options.execArgv ?? process.execArgv).filter((argument) => !argument.startsWith("--inspect"));
	return {
		command,
		args: [...execArgv, entryPath, ...forwardedArgs, "--mode", "json", "--no-session"],
	};
}

export async function executeAgentChild(
	contract: EffectiveRunContract,
	forwardedArgs: readonly string[],
	cwd: string,
	options: AgentChildOptions = {},
): Promise<AgentExecutionResult> {
	const { command, args } = executableArguments(options, forwardedArgs);
	const accumulator = new RunEventAccumulator();
	let terminationReason: RunTerminationReason | undefined;
	let stderr = "";
	let stopped = false;
	const child = spawnProcess(command, args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		detached: process.platform !== "win32",
	});

	const stop = (reason: RunTerminationReason) => {
		if (stopped) return;
		stopped = true;
		terminationReason = reason;
		if (child.pid !== undefined) killProcessTree(child.pid);
	};

	child.stdin?.on("error", () => {});
	child.stdin?.end(contract.task, "utf8");
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARACTERS);
	});

	if (!child.stdout) throw new Error("Pigo 子进程没有 stdout。");
	child.stdout.setEncoding("utf8");
	const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
	lines.on("line", (line) => {
		if (accumulator.consumeLine(line) === "protocol_error") {
			stop("protocol_error");
			return;
		}
		const breach = accumulator.exceededBudget(contract.budget);
		if (breach) stop(breach);
	});

	const timeout = setTimeout(() => stop("timeout"), contract.budget.timeoutSeconds * 1000);
	let exitCode: number | null = null;
	try {
		exitCode = await waitForChildProcess(child);
	} catch {
		terminationReason = "spawn_error";
	} finally {
		clearTimeout(timeout);
		lines.close();
	}

	const summary = accumulator.summary();
	if (!terminationReason) {
		terminationReason = exitCode === 0 && summary.agentEnded && !summary.agentFailed ? "completed" : "agent_failed";
	}
	return { exitCode, terminationReason, stderr, summary };
}

function receiptExitCode(outcome: RunOutcome): number {
	if (outcome === "verified" || outcome === "completed") return 0;
	if (outcome === "failed") return 1;
	if (outcome === "unverified") return 2;
	return 3;
}

function determineOutcome(
	execution: AgentExecutionResult,
	changedCount: number,
	headChanged: boolean,
	scopeViolationCount: number,
	verification: readonly RunVerificationEvidence[],
): RunOutcome {
	const budgetViolation = ["timeout", "token_budget", "tool_budget"].includes(execution.terminationReason);
	if (budgetViolation || headChanged || scopeViolationCount > 0) return "noncompliant";
	if (execution.terminationReason !== "completed" || execution.exitCode !== 0 || execution.summary.agentFailed) {
		return "failed";
	}
	const checkStatuses = verification.flatMap((entry) => entry.checks.map((check) => check.status));
	if (checkStatuses.some((status) => status === "failed" || status === "timed_out")) return "failed";
	if (changedCount === 0) return "completed";
	if (verification.length === 0 || verification.some((entry) => !entry.passed)) return "unverified";
	return "verified";
}

function commandEvidence(command: string | undefined, workspaceRoot: string): string | undefined {
	if (!command) return undefined;
	const normalizedRoot = workspaceRoot.replaceAll("\\", "/");
	return command.replaceAll("\\", "/").replaceAll(normalizedRoot, ".").slice(0, 1000);
}

async function collectVerificationEvidence(
	contract: EffectiveRunContract,
	workspaceRoot: string,
	dependencies: RunCommandDependencies,
	deadlineMs: number,
): Promise<{ evidence: RunVerificationEvidence[]; timedOut: boolean }> {
	const evidence: RunVerificationEvidence[] = [];
	for (const item of contract.verification) {
		const remainingMs = deadlineMs - dependencies.monotonicNow();
		if (remainingMs <= 0) return { evidence, timedOut: true };
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const budgetTimeout = new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new RunBudgetTimeoutError("独立验证超过整体执行预算。")), remainingMs);
			});
			const result = await Promise.race([dependencies.verify(item, workspaceRoot, remainingMs), budgetTimeout]);
			evidence.push({
				operation: item.operation,
				path: item.path,
				passed: result.details.passed,
				durationMs: result.details.durationMs,
				checks: result.details.checks.map((check) => ({
					id: check.id,
					status: check.status,
					durationMs: check.durationMs,
					...(commandEvidence(check.command, workspaceRoot) === undefined
						? {}
						: { command: commandEvidence(check.command, workspaceRoot) }),
				})),
			});
			if (dependencies.monotonicNow() >= deadlineMs) return { evidence, timedOut: true };
		} catch (error) {
			if (error instanceof RunBudgetTimeoutError) return { evidence, timedOut: true };
			evidence.push({ operation: item.operation, path: item.path, passed: false, durationMs: 0, checks: [] });
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	}
	return { evidence, timedOut: false };
}

function printRunHelp(write: (value: string) => void): void {
	write(`pigo run <task> [options] [-- <pigo options>]

Execute the existing Pigo Agent, independently verify its changes, and write an integrity receipt.

Options:
  --contract <file>       Load a version-1 JSON task contract instead of positional task text
  --scope <path>          Allow final changes under this Git-relative path (repeatable)
  --verify <op[:path]>    auto, typecheck, test, lint, or none (repeatable; default: auto:.)
  --timeout <seconds>     Whole-run wall-clock budget (default: 1800)
  --max-tokens <count>    Token budget (default: 200000)
  --max-tool-calls <n>    Tool-call budget (default: 200)
  --receipt <file>        Receipt path (default: private current-project store); never overwritten
  --check-receipt <file>  Verify a receipt without starting an Agent
  --json                  Write only machine-readable JSON to stdout
  -h, --help              Show this help

Examples:
  pigo run "Fix the parser and add a focused test"
  pigo run "Fix parser" --scope src --scope test --verify auto:.
  pigo run --contract pigo.run.json --receipt artifacts/run.json --json
  pigo run "Fix parser" -- --model openai/gpt-5.6
`);
}

async function checkExistingReceipt(
	receiptPath: string,
	json: boolean,
	dependencies: RunCommandDependencies,
): Promise<number> {
	const absolutePath = path.resolve(dependencies.cwd(), receiptPath);
	const envelope = verifyRunReceiptText(await dependencies.readTextFile(absolutePath));
	if (json) {
		dependencies.writeStdout(
			`${JSON.stringify({
				valid: true,
				runId: envelope.receipt.runId,
				outcome: envelope.receipt.result.outcome,
				digest: envelope.integrity.digest,
			})}\n`,
		);
	} else {
		dependencies.writeStdout(
			`回执有效：${envelope.receipt.runId} · ${envelope.receipt.result.outcome} · sha256:${envelope.integrity.digest}\n`,
		);
	}
	dependencies.setExitCode(0);
	return 0;
}

export async function runRunCommand(
	args: readonly string[],
	dependencies: RunCommandDependencies = defaultDependencies(),
): Promise<number> {
	let running = false;
	try {
		const parsed = parseRunArguments(args);
		if (parsed.help) {
			printRunHelp(dependencies.writeStdout);
			dependencies.setExitCode(0);
			return 0;
		}
		if (parsed.checkReceiptPath) {
			running = true;
			return await checkExistingReceipt(parsed.checkReceiptPath, parsed.json, dependencies);
		}

		const cwd = dependencies.cwd();
		const workspaceRoot = await dependencies.getWorkspaceRoot(cwd);
		const document = parsed.contractPath
			? parseRunContractText(await dependencies.readTextFile(path.resolve(cwd, parsed.contractPath)))
			: undefined;
		const contract = createEffectiveRunContract(parsed, document, workspaceRoot);
		const runId = dependencies.randomUUID();
		const receiptPath = path.resolve(
			cwd,
			parsed.receiptPath ?? dependencies.defaultReceiptPath(runId, workspaceRoot),
		);
		await dependencies.assertReceiptTargetAvailable(receiptPath);
		const before = await dependencies.takeSnapshot(workspaceRoot);
		const startedAt = dependencies.now();
		const deadlineMs = dependencies.monotonicNow() + contract.budget.timeoutSeconds * 1000;
		running = true;
		const execution = await dependencies.executeAgent(contract, parsed.forwardedArgs, workspaceRoot);
		const after = await dependencies.takeSnapshot(workspaceRoot);
		const comparison = compareWorkspaceSnapshots(before, after, contract.scope);
		let wholeRunTimedOut = dependencies.monotonicNow() >= deadlineMs;
		let verification: RunVerificationEvidence[] = [];
		if (!wholeRunTimedOut && comparison.changed.length > 0) {
			const collected = await collectVerificationEvidence(contract, workspaceRoot, dependencies, deadlineMs);
			verification = collected.evidence;
			wholeRunTimedOut = collected.timedOut;
		}
		const finalExecution: AgentExecutionResult = wholeRunTimedOut
			? { ...execution, terminationReason: "timeout" }
			: execution;
		const outcome = determineOutcome(
			finalExecution,
			comparison.changed.length,
			comparison.headChanged,
			comparison.scopeViolations.length,
			verification,
		);
		const finishedAt = dependencies.now();
		const finalResponse = execution.summary.finalResponse;
		const receipt: RunReceipt = {
			schemaVersion: 1,
			runId,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
			contract: {
				sha256: hashRunContract(contract),
				task: hashPrivateText(contract.task),
				scope: contract.scope,
				verification: contract.verification,
				budget: contract.budget,
			},
			workspace: {
				coverage: before.coverage,
				headBefore: comparison.headBefore,
				headAfter: comparison.headAfter,
				headChanged: comparison.headChanged,
				beforeDigest: comparison.beforeDigest,
				afterDigest: comparison.afterDigest,
				changed: comparison.changed,
				scopeViolations: comparison.scopeViolations,
			},
			execution: {
				exitCode: finalExecution.exitCode,
				terminationReason: finalExecution.terminationReason,
				turns: execution.summary.turns,
				toolCalls: execution.summary.toolCalls,
				toolErrors: execution.summary.toolErrors,
				usage: execution.summary.usage,
				...(execution.summary.model === undefined ? {} : { model: execution.summary.model }),
				...(finalResponse === undefined
					? {}
					: {
							finalResponse: {
								sha256: hashPrivateText(finalResponse).sha256,
								characters: finalResponse.length,
							},
						}),
				protocolErrors: execution.summary.protocolErrors,
			},
			verification,
			result: { outcome },
		};
		const envelope = createRunReceiptEnvelope(receipt);
		await dependencies.writeReceipt(receiptPath, envelope);
		const exitCode = receiptExitCode(outcome);
		if (parsed.json) {
			dependencies.writeStdout(`${JSON.stringify(envelope)}\n`);
		} else {
			if (finalResponse) dependencies.writeStdout(`${finalResponse}\n`);
			if (exitCode !== 0 && execution.stderr.trim()) dependencies.writeStderr(`${execution.stderr.trim()}\n`);
			dependencies.writeStderr(`pigo run: ${outcome} · receipt: ${receiptPath}\n`);
		}
		dependencies.setExitCode(exitCode);
		return exitCode;
	} catch (error) {
		const exitCode = running ? 1 : 2;
		dependencies.writeStderr(`pigo run: ${error instanceof Error ? error.message : String(error)}\n`);
		dependencies.setExitCode(exitCode);
		return exitCode;
	}
}
