import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "../../config.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { commandDisplay, runVerifyCommand } from "./process.ts";
import type {
	PlannedVerifyCheck,
	VerifyCommandResult,
	VerifyCommandRunner,
	VerifyDetails,
	VerifyRequest,
	VerifyResult,
	VerifyToolService,
} from "./types.ts";
import { createVerifyPlan } from "./workspace.ts";

const MAX_IMPORTANT_LINES = 40;
const MAX_LINE_LENGTH = 500;

export interface VerifyServiceOptions {
	runner?: VerifyCommandRunner;
	logDirectory?: string;
}

function cleanOutput(output: string): string {
	return stripAnsi(sanitizeBinaryOutput(output)).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function importantOutput(output: string): string {
	const lines = cleanOutput(output)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	const importantPattern = /(?:error|failed|failure|exception|assert|panic|fatal|TS\d+|:\d+:\d+)/i;
	const important = lines.filter((line) => importantPattern.test(line));
	const selected = (important.length > 0 ? important : lines.slice(-MAX_IMPORTANT_LINES)).slice(
		0,
		MAX_IMPORTANT_LINES,
	);
	return selected
		.map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line))
		.join("\n");
}

async function writeFailureLog(directory: string, operation: string, output: string): Promise<string> {
	await mkdir(directory, { recursive: true });
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const logPath = path.join(directory, `${timestamp}-${operation}-${randomUUID().slice(0, 8)}.log`);
	await writeFile(logPath, cleanOutput(output), "utf8");
	return logPath;
}

async function runCheck(
	check: PlannedVerifyCheck,
	runner: VerifyCommandRunner,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<{ result: VerifyCommandResult; command?: PlannedVerifyCheck["commands"][number] }> {
	let lastResult: VerifyCommandResult = { kind: "not_found", output: "", outputTruncated: false };
	for (const command of check.commands) {
		lastResult = await runner(command, signal, timeoutMs);
		if (lastResult.kind !== "not_found") return { result: lastResult, command };
	}
	return { result: lastResult };
}

export class VerifyService implements VerifyToolService {
	private readonly runner: VerifyCommandRunner;
	private readonly logDirectory: string;

	constructor(options: VerifyServiceOptions = {}) {
		this.runner = options.runner ?? runVerifyCommand;
		this.logDirectory = options.logDirectory ?? path.join(getAgentDir(), "verify-logs");
	}

	async verify(
		request: VerifyRequest,
		cwd: string,
		signal?: AbortSignal,
		onStatus?: (message: string) => void,
	): Promise<VerifyResult> {
		const startedAt = Date.now();
		onStatus?.("正在确定最小验证范围…");
		const plan = await createVerifyPlan(request, cwd);
		const timeoutMs = Math.min(300_000, Math.max(5_000, (request.timeoutSeconds ?? 60) * 1000));
		const controller = new AbortController();
		const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const details: VerifyDetails = {
			operation: request.operation,
			language: plan.workspace.language,
			workspaceRoot: plan.workspace.workspaceRoot,
			passed: false,
			checks: [],
			truncated: false,
			durationMs: 0,
		};
		const lines: string[] = [];

		try {
			for (const check of plan.checks) {
				onStatus?.(`正在执行 ${check.label}…`);
				const { result, command } = await runCheck(check, this.runner, combinedSignal, timeoutMs);
				const durationMs = result.durationMs ?? 0;
				const display = command ? commandDisplay(command.command, command.args) : undefined;
				if (result.kind === "aborted") throw new Error("verify 已取消。");
				if (result.kind === "not_found") {
					details.checks.push({ id: check.id, label: check.label, status: "unavailable", durationMs });
					lines.push(`[未执行] ${check.label}：${check.missingHint}`);
					continue;
				}
				if (result.kind === "timed_out") {
					details.checks.push({
						id: check.id,
						label: check.label,
						status: "timed_out",
						durationMs,
						...(display ? { command: display } : {}),
					});
					lines.push(`[超时] ${check.label} 超过 ${timeoutMs / 1000} 秒，已停止；任务可以继续。`);
					break;
				}
				if (result.code !== 0) {
					const logPath = await writeFailureLog(this.logDirectory, check.id, result.output);
					details.logPath = logPath;
					details.truncated = result.outputTruncated;
					details.checks.push({
						id: check.id,
						label: check.label,
						status: "failed",
						durationMs,
						...(display ? { command: display } : {}),
					});
					lines.push(`[失败] ${check.label}${display ? `\n命令：${display}` : ""}`);
					const important = importantOutput(result.output);
					if (important) lines.push(`关键输出：\n${important}`);
					lines.push(`详细日志：${logPath}`);
					break;
				}
				details.checks.push({
					id: check.id,
					label: check.label,
					status: "passed",
					durationMs,
					...(display ? { command: display } : {}),
				});
				lines.push(`[通过] ${check.label}${durationMs > 0 ? `（${(durationMs / 1000).toFixed(1)} 秒）` : ""}`);
			}

			lines.push(...plan.notes);
			details.passed = details.checks.length > 0 && details.checks.every((check) => check.status === "passed");
			details.durationMs = Date.now() - startedAt;
			if (details.passed) lines.unshift(`${details.checks.length} 项验证全部通过。`);
			else if (details.checks.length === 0) lines.unshift("没有找到可执行的验证项。");
			return { text: lines.join("\n"), details };
		} finally {
			controller.abort();
		}
	}
}
