import { createHash } from "node:crypto";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { canonicalJson, type RunVerificationContract } from "../../cli/run-contract.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { ObservedToolResult } from "../execution-controller/policy.ts";
import { formatGoalDuration, GOAL_STATUS_LABELS } from "./control.ts";
import {
	GOAL_LOOP_ENTRY_TYPE,
	GOAL_LOOP_SCHEMA_VERSION,
	type GoalLoopCommand,
	type GoalLoopReport,
	type GoalLoopStartArguments,
	type GoalLoopState,
	type GoalVerificationResult,
	MAX_GOAL_GAP_LENGTH,
	MAX_GOAL_ITERATION_HISTORY,
	MAX_GOAL_LENGTH,
	MAX_GOAL_QUESTION_LENGTH,
	MAX_GOAL_REPORT_LENGTH,
	MAX_GOAL_SCOPE_COUNT,
	MAX_GOAL_VERIFICATION_COUNT,
} from "./types.ts";

const DEFAULT_TIMEOUT_SECONDS = 7_200;
const DEFAULT_MAX_TOKENS = 400_000;
const DEFAULT_MAX_TOOL_CALLS = 400;
const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_TOKENS = 10_000_000;
const MAX_TOOL_CALLS = 10_000;
const MAX_ITERATIONS = 64;
const STUCK_GAP_LIMIT = 2;
const VERIFY_OPERATIONS = new Set(["auto", "typecheck", "test", "lint"]);
const GOAL_LOOP_STATUSES = new Set<GoalLoopState["status"]>([
	"running",
	"verifying",
	"paused",
	"waiting_user",
	"verified",
	"budget_exhausted",
	"stuck",
	"stopped",
	"failed",
]);
const GOAL_REPORT_STATUSES = new Set<GoalLoopReport["status"]>(["complete", "continue", "needs_user"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, label: string, maximum: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (!normalized) throw new Error(`${label}不能为空。`);
	if (normalized.length > maximum) throw new Error(`${label}最多 ${maximum} 个字符。`);
	return normalized;
}

function boundedInteger(value: string, option: string, maximum: number): number {
	if (!/^\d+$/.test(value)) throw new Error(`${option} 必须是正整数。`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new Error(`${option} 必须是 1 到 ${maximum} 之间的整数。`);
	}
	return parsed;
}

function optionValue(tokens: readonly string[], index: number, option: string, inline?: string): string {
	if (inline !== undefined) {
		if (!inline) throw new Error(`${option} 缺少值。`);
		return inline;
	}
	const value = tokens[index + 1];
	if (value === undefined || value === "--") throw new Error(`${option} 缺少值。`);
	return value;
}

function parseVerification(value: string): RunVerificationContract {
	const separator = value.indexOf(":");
	const operation = separator === -1 ? value : value.slice(0, separator);
	const verifyPath = separator === -1 ? "." : value.slice(separator + 1).trim();
	if (!VERIFY_OPERATIONS.has(operation)) throw new Error("--verify 必须是 auto、typecheck、test 或 lint。");
	if (!verifyPath) throw new Error("--verify 路径不能为空。");
	return {
		operation: operation as RunVerificationContract["operation"],
		path: verifyPath,
		timeoutSeconds: DEFAULT_VERIFY_TIMEOUT_SECONDS,
	};
}

export function tokenizeGoalCommand(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < input.length; index += 1) {
		const character = input[index] as string;
		if (quote) {
			if (character === quote) {
				quote = undefined;
				continue;
			}
			if (character === "\\" && input[index + 1] === quote) {
				current += quote;
				index += 1;
				continue;
			}
			current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (quote) throw new Error("命令包含未闭合的引号。");
	if (current) tokens.push(current);
	return tokens;
}

export function parseGoalLoopCommand(input: string): GoalLoopCommand {
	const tokens = tokenizeGoalCommand(input.trim());
	if (tokens.length === 0) return { action: "control" };

	const goalParts: string[] = [];
	const scopes: string[] = [];
	const verification: RunVerificationContract[] = [];
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	let maxTokens = DEFAULT_MAX_TOKENS;
	let maxToolCalls = DEFAULT_MAX_TOOL_CALLS;
	let maxIterations = DEFAULT_MAX_ITERATIONS;
	let positionalOnly = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		if (token === "--") {
			positionalOnly = true;
			continue;
		}
		if (positionalOnly || !token.startsWith("-")) {
			goalParts.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		const option = equals === -1 ? token : token.slice(0, equals);
		const inline = equals === -1 ? undefined : token.slice(equals + 1);
		const value = optionValue(tokens, index, option, inline);
		if (inline === undefined) index += 1;
		if (option === "--timeout") timeoutSeconds = boundedInteger(value, option, MAX_TIMEOUT_SECONDS);
		else if (option === "--max-tokens") maxTokens = boundedInteger(value, option, MAX_TOKENS);
		else if (option === "--max-tool-calls") maxToolCalls = boundedInteger(value, option, MAX_TOOL_CALLS);
		else if (option === "--max-iterations") maxIterations = boundedInteger(value, option, MAX_ITERATIONS);
		else if (option === "--scope") {
			if (scopes.length >= MAX_GOAL_SCOPE_COUNT) {
				throw new Error(`--scope 最多可提供 ${MAX_GOAL_SCOPE_COUNT} 次。`);
			}
			scopes.push(value);
		} else if (option === "--verify") {
			if (verification.length >= MAX_GOAL_VERIFICATION_COUNT) {
				throw new Error(`--verify 最多可提供 ${MAX_GOAL_VERIFICATION_COUNT} 次。`);
			}
			verification.push(parseVerification(value));
		} else throw new Error(`未知选项“${option}”。`);
	}
	const goal = boundedText(goalParts.join(" "), "目标", MAX_GOAL_LENGTH);
	const uniqueVerification = [
		...new Map(verification.map((entry) => [`${entry.operation}\0${entry.path}`, entry])).values(),
	];
	return {
		action: "start",
		arguments: {
			goal,
			scope: scopes.length > 0 ? [...new Set(scopes)] : ["."],
			verification:
				uniqueVerification.length > 0
					? uniqueVerification
					: [{ operation: "auto", path: ".", timeoutSeconds: DEFAULT_VERIFY_TIMEOUT_SECONDS }],
			budget: { timeoutSeconds, maxTokens, maxToolCalls, maxIterations },
		},
	};
}

function createMetrics(): GoalLoopState["metrics"] {
	return {
		turns: 0,
		toolCalls: {},
		toolErrors: 0,
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			cost: 0,
		},
	};
}

export function createGoalLoopState(
	arguments_: GoalLoopStartArguments,
	options: { runId: string; workspaceRoot: string; baselinePath: string; now: string },
): GoalLoopState {
	return {
		schemaVersion: GOAL_LOOP_SCHEMA_VERSION,
		revision: 0,
		runId: options.runId,
		goal: arguments_.goal,
		workspaceRoot: options.workspaceRoot,
		baselinePath: options.baselinePath,
		status: "running",
		startedAt: options.now,
		updatedAt: options.now,
		iteration: 1,
		scope: [...arguments_.scope],
		verification: arguments_.verification.map((entry) => ({ ...entry })),
		budget: { ...arguments_.budget },
		metrics: createMetrics(),
		iterations: [{ number: 1, startedAt: options.now, verification: [] }],
		repeatedGapCount: 0,
	};
}

function cloneState(state: GoalLoopState): GoalLoopState {
	return structuredClone(state);
}

function bump(state: GoalLoopState, now: string): GoalLoopState {
	state.revision += 1;
	state.updatedAt = now;
	return state;
}

function isUsage(value: unknown): value is Usage {
	return (
		isRecord(value) &&
		isNonnegativeNumber(value.input) &&
		isNonnegativeNumber(value.output) &&
		isNonnegativeNumber(value.cacheRead) &&
		isNonnegativeNumber(value.cacheWrite) &&
		isNonnegativeNumber(value.totalTokens) &&
		isRecord(value.cost) &&
		isNonnegativeNumber(value.cost.total)
	);
}

export function recordGoalTurn(
	state: GoalLoopState,
	usage: unknown,
	response: string | undefined,
	now: string,
): GoalLoopState {
	const next = cloneState(state);
	next.metrics.turns += 1;
	addGoalUsage(next, usage);
	if (response) next.lastResponse = response.slice(0, MAX_GOAL_REPORT_LENGTH);
	return bump(next, now);
}

function addGoalUsage(state: GoalLoopState, usage: unknown): void {
	if (isUsage(usage)) {
		state.metrics.usage.inputTokens += Math.max(0, usage.input);
		state.metrics.usage.outputTokens += Math.max(0, usage.output);
		state.metrics.usage.cacheReadTokens += Math.max(0, usage.cacheRead);
		state.metrics.usage.cacheWriteTokens += Math.max(0, usage.cacheWrite);
		state.metrics.usage.totalTokens += Math.max(0, usage.totalTokens);
		state.metrics.usage.cost += Math.max(0, usage.cost.total);
	}
}

export function recordGoalUsage(state: GoalLoopState, usage: unknown, now: string): GoalLoopState {
	const next = cloneState(state);
	addGoalUsage(next, usage);
	return bump(next, now);
}

function boundedToolName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 100) || "unknown";
}

export function recordGoalTool(state: GoalLoopState, event: ObservedToolResult, now: string): GoalLoopState {
	const next = cloneState(state);
	const name = boundedToolName(event.toolName);
	next.metrics.toolCalls[name] = (next.metrics.toolCalls[name] ?? 0) + 1;
	if (event.isError) next.metrics.toolErrors += 1;
	return bump(next, now);
}

export function setGoalReport(state: GoalLoopState, report: GoalLoopReport, now: string): GoalLoopState {
	if (state.status !== "running") throw new Error("当前没有正在执行的目标轮次。");
	const next = cloneState(state);
	const iteration = next.iterations.at(-1);
	if (!iteration || iteration.number !== next.iteration) throw new Error("目标轮次状态不一致。");
	if (iteration.report) throw new Error("本轮已经提交 goal_report，不能覆盖第一次报告。");
	iteration.report = {
		status: report.status,
		summary: boundedText(report.summary, "执行摘要", MAX_GOAL_REPORT_LENGTH),
		...(report.gap === undefined ? {} : { gap: boundedText(report.gap, "剩余差距", MAX_GOAL_GAP_LENGTH) }),
		...(report.question === undefined
			? {}
			: { question: boundedText(report.question, "用户问题", MAX_GOAL_QUESTION_LENGTH) }),
	};
	if (iteration.report.status === "needs_user" && !iteration.report.question) {
		throw new Error("needs_user 必须提供一个具体问题。");
	}
	return bump(next, now);
}

export function beginGoalVerification(state: GoalLoopState, now: string): GoalLoopState {
	if (state.status !== "running") throw new Error("只有正在执行的目标可以进入验证。");
	const next = cloneState(state);
	next.status = "verifying";
	delete next.reason;
	return bump(next, now);
}

function totalToolCalls(state: GoalLoopState): number {
	return Object.values(state.metrics.toolCalls).reduce((sum, count) => sum + count, 0);
}

export type GoalBudgetBreach = "timeout" | "token_budget" | "tool_budget" | "iteration_budget";

export function goalBudgetBreach(state: GoalLoopState, nowMs: number): GoalBudgetBreach | undefined {
	if (nowMs - Date.parse(state.startedAt) >= state.budget.timeoutSeconds * 1000) return "timeout";
	if (state.metrics.usage.totalTokens >= state.budget.maxTokens) return "token_budget";
	if (totalToolCalls(state) >= state.budget.maxToolCalls) return "tool_budget";
	if (state.iteration >= state.budget.maxIterations) return "iteration_budget";
	return undefined;
}

function normalizeGap(gap: string): string {
	return gap
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[a-z]:[\\/][^\s:"'<>|]+(?:[\\/][^\s:"'<>|]+)*/giu, "<path>")
		.replace(/\b\d+(?:\.\d+)?\b/gu, "<n>")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, MAX_GOAL_GAP_LENGTH);
}

export function fingerprintGoalGap(gap: string, workspaceDigest: string): string {
	return createHash("sha256")
		.update(canonicalJson({ gap: normalizeGap(gap), workspaceDigest }))
		.digest("hex");
}

export function applyGoalVerification(
	state: GoalLoopState,
	result: GoalVerificationResult,
	nowMs = Date.parse(result.finishedAt),
): GoalLoopState {
	if (state.status !== "verifying") throw new Error("只有验证中的目标可以提交验证结果。");
	const next = cloneState(state);
	applyGoalVerificationEvidence(next, result);
	const iteration = next.iterations.at(-1) as GoalLoopState["iterations"][number];
	const report = iteration.report;
	const allPassed = result.evidence.length > 0 && result.evidence.every((entry) => entry.passed);
	const workspaceCompliant =
		!result.workspaceCompliance.headChanged && result.workspaceCompliance.scopeViolations.length === 0;

	if (report?.status === "needs_user") {
		next.status = "waiting_user";
		next.reason = report.question;
		return bump(next, result.finishedAt);
	}
	if (report?.status === "complete" && allPassed && workspaceCompliant) {
		next.status = "verified";
		next.reason = "目标报告完成，且独立验证全部通过。";
		return bump(next, result.finishedAt);
	}

	const breach = goalBudgetBreach(next, nowMs);
	if (breach) {
		next.status = "budget_exhausted";
		next.reason = breach;
		return bump(next, result.finishedAt);
	}

	const gap = result.gap || report?.gap || "Agent 未报告完成状态。";
	const fingerprint = fingerprintGoalGap(gap, result.workspaceDigest);
	iteration.gapFingerprint = fingerprint;
	if (fingerprint === next.lastGapFingerprint) next.repeatedGapCount += 1;
	else next.repeatedGapCount = 1;
	next.lastGapFingerprint = fingerprint;
	if (next.repeatedGapCount >= STUCK_GAP_LIMIT) {
		next.status = "stuck";
		next.reason = `连续 ${next.repeatedGapCount} 轮出现相同差距且工作区证据未变化：${gap}`.slice(
			0,
			MAX_GOAL_GAP_LENGTH,
		);
		return bump(next, result.finishedAt);
	}

	next.iteration += 1;
	next.status = "running";
	next.iterations = [
		...next.iterations.slice(-(MAX_GOAL_ITERATION_HISTORY - 1)),
		{ number: next.iteration, startedAt: result.finishedAt, verification: [] },
	];
	next.reason = gap.slice(0, MAX_GOAL_GAP_LENGTH);
	return bump(next, result.finishedAt);
}

function applyGoalVerificationEvidence(state: GoalLoopState, result: GoalVerificationResult): void {
	const iteration = state.iterations.at(-1);
	if (!iteration || iteration.number !== state.iteration) throw new Error("目标轮次状态不一致。");
	iteration.finishedAt = result.finishedAt;
	iteration.verification = result.evidence.map((entry) => ({
		...entry,
		checks: entry.checks.map((check) => ({ ...check })),
	}));
	iteration.workspaceDigest = result.workspaceDigest;
	iteration.workspaceCompliance = {
		headChanged: result.workspaceCompliance.headChanged,
		scopeViolations: [...result.workspaceCompliance.scopeViolations],
	};
	iteration.gap = result.gap.slice(0, MAX_GOAL_GAP_LENGTH);
}

export function recordGoalVerificationEvidence(state: GoalLoopState, result: GoalVerificationResult): GoalLoopState {
	if (state.status !== "verifying") throw new Error("只有验证中的目标可以保存验证结果。");
	const next = cloneState(state);
	applyGoalVerificationEvidence(next, result);
	return bump(next, result.finishedAt);
}

export function pauseGoalLoop(state: GoalLoopState, reason: string, now: string): GoalLoopState {
	if (state.status !== "running" && state.status !== "verifying") throw new Error("当前目标不能暂停。");
	const next = cloneState(state);
	next.status = "paused";
	next.reason = boundedText(reason, "暂停原因", MAX_GOAL_GAP_LENGTH);
	return bump(next, now);
}

export function resumeGoalLoop(state: GoalLoopState, decision: string | undefined, now: string): GoalLoopState {
	if (state.status !== "paused" && state.status !== "waiting_user" && state.status !== "stuck") {
		throw new Error("当前目标不处于可恢复状态。");
	}
	if ((state.status === "waiting_user" || state.status === "stuck") && !decision?.trim()) {
		throw new Error("该目标需要具体决策；请打开 /run 并提供你的决定。");
	}
	const next = cloneState(state);
	next.repeatedGapCount = 0;
	delete next.lastGapFingerprint;
	const currentIteration = next.iterations.at(-1);
	if (state.status === "paused" && currentIteration?.report && !currentIteration.finishedAt) {
		next.status = "verifying";
		next.reason = "恢复暂停前尚未执行的独立验证。";
		return bump(next, now);
	}
	if (currentIteration?.finishedAt) {
		if (next.iteration >= next.budget.maxIterations) {
			next.status = "budget_exhausted";
			next.reason = "iteration_budget";
			return bump(next, now);
		}
		next.iteration += 1;
		next.iterations = [
			...next.iterations.slice(-(MAX_GOAL_ITERATION_HISTORY - 1)),
			{ number: next.iteration, startedAt: now, verification: [] },
		];
	}
	next.status = "running";
	next.reason = decision ? boundedText(decision, "恢复说明", MAX_GOAL_GAP_LENGTH) : "用户恢复执行。";
	return bump(next, now);
}

export function stopGoalLoop(state: GoalLoopState, now: string): GoalLoopState {
	if (["verified", "budget_exhausted", "stopped", "failed"].includes(state.status)) {
		throw new Error("当前目标已经结束。");
	}
	const next = cloneState(state);
	next.status = "stopped";
	next.reason = "用户停止执行。";
	return bump(next, now);
}

export function failGoalLoop(state: GoalLoopState, reason: string, now: string): GoalLoopState {
	const next = cloneState(state);
	next.status = "failed";
	next.reason = boundedText(reason, "失败原因", MAX_GOAL_GAP_LENGTH);
	return bump(next, now);
}

export function exhaustGoalBudget(state: GoalLoopState, breach: GoalBudgetBreach, now: string): GoalLoopState {
	const next = cloneState(state);
	next.status = "budget_exhausted";
	next.reason = breach;
	return bump(next, now);
}

export function setGoalReceiptPath(state: GoalLoopState, receiptPath: string, now: string): GoalLoopState {
	const next = cloneState(state);
	next.receiptPath = receiptPath;
	delete next.receiptError;
	return bump(next, now);
}

export function setGoalReceiptError(state: GoalLoopState, error: string, _now: string): GoalLoopState {
	const next = cloneState(state);
	next.receiptError = boundedText(error, "回执错误", MAX_GOAL_GAP_LENGTH);
	next.revision += 1;
	return next;
}

function isNonnegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && isNonnegativeNumber(value);
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown, maximum: number): boolean {
	return value === undefined || (typeof value === "string" && value.length <= maximum);
}

function isVerificationContract(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.operation === "string" &&
		VERIFY_OPERATIONS.has(value.operation) &&
		typeof value.path === "string" &&
		value.path.length > 0 &&
		isPositiveInteger(value.timeoutSeconds)
	);
}

function isVerificationEvidence(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.operation === "string" &&
		VERIFY_OPERATIONS.has(value.operation) &&
		typeof value.path === "string" &&
		typeof value.passed === "boolean" &&
		isNonnegativeNumber(value.durationMs) &&
		Array.isArray(value.checks) &&
		value.checks.every(
			(check) =>
				isRecord(check) &&
				typeof check.id === "string" &&
				typeof check.status === "string" &&
				isNonnegativeNumber(check.durationMs) &&
				isOptionalString(check.command, 1_000),
		)
	);
}

function isGoalReport(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.status === "string" &&
		GOAL_REPORT_STATUSES.has(value.status as GoalLoopReport["status"]) &&
		typeof value.summary === "string" &&
		value.summary.length > 0 &&
		value.summary.length <= MAX_GOAL_REPORT_LENGTH &&
		isOptionalString(value.gap, MAX_GOAL_GAP_LENGTH) &&
		isOptionalString(value.question, MAX_GOAL_QUESTION_LENGTH) &&
		(value.status !== "needs_user" || (typeof value.question === "string" && value.question.length > 0))
	);
}

function isGoalIteration(value: unknown): boolean {
	return (
		isRecord(value) &&
		isPositiveInteger(value.number) &&
		isTimestamp(value.startedAt) &&
		(value.finishedAt === undefined || isTimestamp(value.finishedAt)) &&
		(value.report === undefined || isGoalReport(value.report)) &&
		Array.isArray(value.verification) &&
		value.verification.every(isVerificationEvidence) &&
		isOptionalString(value.workspaceDigest, 128) &&
		(value.workspaceCompliance === undefined ||
			(isRecord(value.workspaceCompliance) &&
				typeof value.workspaceCompliance.headChanged === "boolean" &&
				Array.isArray(value.workspaceCompliance.scopeViolations) &&
				value.workspaceCompliance.scopeViolations.length <= MAX_GOAL_SCOPE_COUNT &&
				value.workspaceCompliance.scopeViolations.every((entry) => typeof entry === "string"))) &&
		isOptionalString(value.gap, MAX_GOAL_GAP_LENGTH) &&
		isOptionalString(value.gapFingerprint, 128)
	);
}

function isGoalBudget(value: unknown): value is GoalLoopState["budget"] {
	return (
		isRecord(value) &&
		isPositiveInteger(value.timeoutSeconds) &&
		value.timeoutSeconds <= MAX_TIMEOUT_SECONDS &&
		isPositiveInteger(value.maxTokens) &&
		value.maxTokens <= MAX_TOKENS &&
		isPositiveInteger(value.maxToolCalls) &&
		value.maxToolCalls <= MAX_TOOL_CALLS &&
		isPositiveInteger(value.maxIterations) &&
		value.maxIterations <= MAX_ITERATIONS
	);
}

function isGoalMetrics(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.toolCalls) || !isRecord(value.usage)) return false;
	return (
		isNonnegativeInteger(value.turns) &&
		Object.entries(value.toolCalls).every(
			([name, count]) => name.length > 0 && name.length <= 100 && isNonnegativeInteger(count),
		) &&
		isNonnegativeInteger(value.toolErrors) &&
		isNonnegativeNumber(value.usage.inputTokens) &&
		isNonnegativeNumber(value.usage.outputTokens) &&
		isNonnegativeNumber(value.usage.cacheReadTokens) &&
		isNonnegativeNumber(value.usage.cacheWriteTokens) &&
		isNonnegativeNumber(value.usage.totalTokens) &&
		isNonnegativeNumber(value.usage.cost)
	);
}

function isGoalLoopState(value: unknown): value is GoalLoopState {
	if (!isRecord(value) || !isGoalBudget(value.budget)) return false;
	if (!Array.isArray(value.iterations) || value.iterations.length < 1) return false;
	const latestIteration = value.iterations.at(-1);
	return (
		value.schemaVersion === GOAL_LOOP_SCHEMA_VERSION &&
		isNonnegativeInteger(value.revision) &&
		typeof value.runId === "string" &&
		value.runId.length > 0 &&
		value.runId.length <= 200 &&
		typeof value.goal === "string" &&
		value.goal.length > 0 &&
		value.goal.length <= MAX_GOAL_LENGTH &&
		typeof value.workspaceRoot === "string" &&
		value.workspaceRoot.length > 0 &&
		typeof value.baselinePath === "string" &&
		value.baselinePath.length > 0 &&
		typeof value.status === "string" &&
		GOAL_LOOP_STATUSES.has(value.status as GoalLoopState["status"]) &&
		isTimestamp(value.startedAt) &&
		isTimestamp(value.updatedAt) &&
		isPositiveInteger(value.iteration) &&
		value.iteration <= value.budget.maxIterations &&
		Array.isArray(value.scope) &&
		value.scope.length > 0 &&
		value.scope.length <= MAX_GOAL_SCOPE_COUNT &&
		value.scope.every((entry) => typeof entry === "string" && entry.length > 0) &&
		Array.isArray(value.verification) &&
		value.verification.length > 0 &&
		value.verification.length <= MAX_GOAL_VERIFICATION_COUNT &&
		value.verification.every(isVerificationContract) &&
		isGoalMetrics(value.metrics) &&
		value.iterations.length <= MAX_GOAL_ITERATION_HISTORY &&
		value.iterations.every(isGoalIteration) &&
		isRecord(latestIteration) &&
		latestIteration.number === value.iteration &&
		isNonnegativeInteger(value.repeatedGapCount) &&
		isOptionalString(value.lastGapFingerprint, 128) &&
		isOptionalString(value.reason, MAX_GOAL_GAP_LENGTH) &&
		isOptionalString(value.receiptPath, 32_768) &&
		isOptionalString(value.receiptError, MAX_GOAL_GAP_LENGTH) &&
		(value.model === undefined ||
			(isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.id === "string")) &&
		isOptionalString(value.lastResponse, MAX_GOAL_REPORT_LENGTH)
	);
}

export function loadLatestGoalLoopState(entries: readonly SessionEntry[]): GoalLoopState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== GOAL_LOOP_ENTRY_TYPE) continue;
		if (isGoalLoopState(entry.data)) return cloneState(entry.data);
	}
	return undefined;
}

function portableRelative(value: string, root: string, label: string): string {
	const absolute = path.resolve(root, value);
	const relative = path.relative(root, absolute);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`${label} 必须位于当前 Git 工作区。`);
	}
	return relative ? relative.split(path.sep).join("/") : ".";
}

export function normalizeGoalStartArguments(
	arguments_: GoalLoopStartArguments,
	workspaceRoot: string,
): GoalLoopStartArguments {
	if (arguments_.scope.length > MAX_GOAL_SCOPE_COUNT) {
		throw new Error(`--scope 最多可提供 ${MAX_GOAL_SCOPE_COUNT} 次。`);
	}
	if (arguments_.verification.length > MAX_GOAL_VERIFICATION_COUNT) {
		throw new Error(`--verify 最多可提供 ${MAX_GOAL_VERIFICATION_COUNT} 次。`);
	}
	const verification = arguments_.verification.map((entry) => ({
		...entry,
		path: portableRelative(entry.path, workspaceRoot, "--verify"),
	}));
	return {
		goal: arguments_.goal,
		scope: [...new Set(arguments_.scope.map((entry) => portableRelative(entry, workspaceRoot, "--scope")))],
		verification: [...new Map(verification.map((entry) => [`${entry.operation}\0${entry.path}`, entry])).values()],
		budget: { ...arguments_.budget },
	};
}

function budgetPercent(value: number, maximum: number): string {
	return `${((value / maximum) * 100).toFixed(1)}%`;
}

export function formatGoalLoopStatus(state: GoalLoopState | undefined, nowMs = Date.now()): string {
	if (!state) return "目标执行器：当前没有目标。使用 /run <目标> 开始。";
	const tools = totalToolCalls(state);
	const elapsedSeconds = Math.max(0, Math.floor((nowMs - Date.parse(state.startedAt)) / 1_000));
	const remainingSeconds = Math.max(0, state.budget.timeoutSeconds - elapsedSeconds);
	const latestVerification = [...state.iterations].reverse().find((iteration) => iteration.verification.length > 0);
	const evidence = latestVerification?.verification ?? [];
	const passed = evidence.filter((entry) => entry.passed).length;
	const lines = [
		`目标执行器 ${state.runId.slice(0, 8)} · ${GOAL_STATUS_LABELS[state.status]} · 第 ${state.iteration}/${state.budget.maxIterations} 轮`,
		`目标：${state.goal}`,
		`时间：已用 ${formatGoalDuration(elapsedSeconds)} · 剩余 ${formatGoalDuration(remainingSeconds)}`,
		`预算：${state.metrics.usage.totalTokens}/${state.budget.maxTokens} tokens (${budgetPercent(state.metrics.usage.totalTokens, state.budget.maxTokens)}) · ${tools}/${state.budget.maxToolCalls} tools (${budgetPercent(tools, state.budget.maxToolCalls)})`,
		`验收：${evidence.length > 0 ? `${passed}/${evidence.length} 通过 · 最近第 ${latestVerification?.number} 轮` : "尚无独立验证证据"}`,
	];
	if (state.reason) lines.push(`状态：${state.reason}`);
	if (state.receiptPath) lines.push(`回执：${state.receiptPath}`);
	if (state.receiptError) lines.push(`回执错误：${state.receiptError}`);
	return lines.join("\n");
}

export function formatGoalLoopWidget(state: GoalLoopState | undefined): string | undefined {
	if (!state || ["verified", "stopped", "failed"].includes(state.status)) return undefined;
	return `目标 ${GOAL_STATUS_LABELS[state.status]} · ${state.iteration}/${state.budget.maxIterations} · ${state.metrics.usage.totalTokens} tok`;
}

function compactPromptText(value: string | undefined, maximum: number): string {
	if (!value) return "无";
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function recentGoalAttempts(state: GoalLoopState): string {
	const attempts = state.iterations
		.slice(0, -1)
		.filter((iteration) => iteration.finishedAt)
		.slice(-3);
	if (attempts.length === 0) return "暂无；这是第一轮。";
	return attempts
		.map(
			(iteration) =>
				`- 第 ${iteration.number} 轮：执行=${compactPromptText(iteration.report?.summary, 300)}；验证差距=${compactPromptText(iteration.gap, 500)}`,
		)
		.join("\n");
}

export function buildGoalIterationPrompt(state: GoalLoopState): string {
	const previous = state.iterations.length > 1 ? state.iterations.at(-2) : undefined;
	const gap = state.reason ?? previous?.gap ?? "先理解目标、检查现状并制定可验证计划。";
	const scopes = state.scope.join("、");
	const verification = state.verification.map((entry) => `${entry.operation}:${entry.path}`).join("、");
	const remainingTokens = Math.max(0, state.budget.maxTokens - state.metrics.usage.totalTokens);
	const remainingTools = Math.max(0, state.budget.maxToolCalls - totalToolCalls(state));
	return `[PIGO_GOAL_LOOP ${state.runId} 第 ${state.iteration} 轮]

不可变目标：
${state.goal}

当前差距或用户决策：
${gap}

冻结范围：${scopes}
冻结验收：${verification}
剩余预算：${remainingTokens} tokens、${remainingTools} 次工具调用、${state.budget.maxIterations - state.iteration + 1} 轮（含本轮）

最近尝试（不要在证据未变化时重复同一方案）：
${recentGoalAttempts(state)}

请根据原始目标重新规划本轮，执行必要修改并自行做最小检查。不要改变完成标准，不要绕过现有审批、权限或沙箱。只有确实需要会改变产品行为、范围或不可逆选择的用户决定时才暂停。

本轮结束前必须最后调用一次 goal_report：
- 已达到目标：status=complete，并提供完成摘要；
- 仍可自主推进：status=continue，并提供具体剩余差距；
- 确实需要用户决定：status=needs_user，并只提出一个具体问题。

goal_report 只是状态报告。Pigo 会在模型回合结束后独立运行冻结的验收检查，再决定完成、纠偏、停滞或等待用户。`;
}

export function goalLoopSystemContext(state: GoalLoopState): string {
	return `[Pigo 目标执行器]
原始目标、验收项和预算已经冻结。原始目标优先于本轮计划；验证失败时根据差距重新规划，但不得降低验收标准。当前为第 ${state.iteration} 轮，状态 ${state.status}。`;
}
