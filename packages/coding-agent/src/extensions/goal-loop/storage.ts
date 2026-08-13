import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWorkspaceReceiptPath } from "../../cli/project-runs.ts";
import { type EffectiveRunContract, hashRunContract } from "../../cli/run-contract.ts";
import {
	createRunReceiptEnvelope,
	hashPrivateText,
	type RunOutcome,
	type RunReceipt,
	type RunReceiptEnvelope,
	type RunTerminationReason,
	writeRunReceipt,
} from "../../cli/run-receipt.ts";
import { compareWorkspaceSnapshots, takeWorkspaceSnapshot, type WorkspaceSnapshot } from "../../cli/run-workspace.ts";
import { getAgentDir } from "../../config.ts";
import type { GoalLoopState } from "./types.ts";

const GOAL_BASELINE_VERSION = 1;

interface GoalBaselineDocument {
	version: typeof GOAL_BASELINE_VERSION;
	root: string;
	head: string | null;
	digest: string;
	coverage: WorkspaceSnapshot["coverage"];
	index: Array<[string, string]>;
	dirty: Array<[string, string]>;
}

export interface GoalReceiptDependencies {
	takeSnapshot: (cwd: string) => Promise<WorkspaceSnapshot>;
	readBaseline: (filePath: string) => Promise<WorkspaceSnapshot>;
	receiptPath: (runId: string, workspaceRoot: string) => string;
	writeReceipt: (filePath: string, envelope: RunReceiptEnvelope) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPairArray(value: unknown): value is Array<[string, string]> {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string",
		)
	);
}

function parseBaseline(text: string): GoalBaselineDocument {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`目标基线不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
	if (
		!isRecord(value) ||
		value.version !== GOAL_BASELINE_VERSION ||
		typeof value.root !== "string" ||
		(value.head !== null && typeof value.head !== "string") ||
		typeof value.digest !== "string" ||
		value.coverage !== "git-tracked-and-unignored" ||
		!isPairArray(value.index) ||
		!isPairArray(value.dirty)
	) {
		throw new Error("目标基线格式无效。");
	}
	return value as unknown as GoalBaselineDocument;
}

function baselineDocument(snapshot: WorkspaceSnapshot): GoalBaselineDocument {
	return {
		version: GOAL_BASELINE_VERSION,
		root: snapshot.root,
		head: snapshot.head,
		digest: snapshot.digest,
		coverage: snapshot.coverage,
		index: [...snapshot.index.entries()],
		dirty: [...snapshot.dirty.entries()],
	};
}

export async function writeGoalBaseline(
	agentDirectory: string,
	runId: string,
	snapshot: WorkspaceSnapshot,
): Promise<string> {
	const directory = path.join(agentDirectory, "goal-runs", runId);
	await mkdir(directory, { recursive: true });
	const target = path.join(directory, "baseline.json");
	const temporary = path.join(directory, `.baseline-${randomUUID()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(baselineDocument(snapshot))}\n`, { encoding: "utf8", flag: "wx" });
	await rename(temporary, target);
	return target;
}

export async function readGoalBaseline(filePath: string): Promise<WorkspaceSnapshot> {
	const value = parseBaseline(await readFile(filePath, "utf8"));
	return {
		root: value.root,
		head: value.head,
		digest: value.digest,
		coverage: value.coverage,
		index: new Map(value.index),
		dirty: new Map(value.dirty),
	};
}

function terminationReason(state: GoalLoopState): RunTerminationReason {
	if (state.status === "verified") return "completed";
	if (state.status === "budget_exhausted") {
		if (
			state.reason === "timeout" ||
			state.reason === "token_budget" ||
			state.reason === "tool_budget" ||
			state.reason === "iteration_budget"
		) {
			return state.reason;
		}
	}
	if (state.status === "stopped") return "user_stopped";
	return "agent_failed";
}

function latestVerification(state: GoalLoopState): GoalLoopState["iterations"][number]["verification"] {
	return [...state.iterations].reverse().find((iteration) => iteration.verification.length > 0)?.verification ?? [];
}

function outcome(
	state: GoalLoopState,
	changedCount: number,
	headChanged: boolean,
	scopeViolationCount: number,
): RunOutcome {
	if (headChanged || scopeViolationCount > 0) return "noncompliant";
	if (state.status === "budget_exhausted") return "noncompliant";
	if (state.status !== "verified") return "failed";
	if (changedCount === 0) return "completed";
	const verification = latestVerification(state);
	return verification.length > 0 && verification.every((entry) => entry.passed) ? "verified" : "unverified";
}

export function createGoalReceipt(
	state: GoalLoopState,
	before: WorkspaceSnapshot,
	after: WorkspaceSnapshot,
	finishedAt: Date,
): RunReceiptEnvelope {
	const comparison = compareWorkspaceSnapshots(before, after, state.scope);
	const contract: EffectiveRunContract = {
		version: 1,
		task: state.goal,
		scope: state.scope,
		verification: state.verification,
		budget: {
			timeoutSeconds: state.budget.timeoutSeconds,
			maxTokens: state.budget.maxTokens,
			maxToolCalls: state.budget.maxToolCalls,
		},
	};
	const finalVerification = latestVerification(state);
	const response = state.lastResponse;
	const receipt: RunReceipt = {
		schemaVersion: 1,
		runId: state.runId,
		startedAt: state.startedAt,
		finishedAt: finishedAt.toISOString(),
		durationMs: Math.max(0, finishedAt.getTime() - Date.parse(state.startedAt)),
		contract: {
			sha256: hashRunContract(contract),
			task: hashPrivateText(state.goal),
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
			exitCode: state.status === "verified" ? 0 : 1,
			terminationReason: terminationReason(state),
			turns: state.metrics.turns,
			toolCalls: { ...state.metrics.toolCalls },
			toolErrors: state.metrics.toolErrors,
			usage: { ...state.metrics.usage },
			...(state.model === undefined ? {} : { model: { ...state.model } }),
			...(response === undefined
				? {}
				: { finalResponse: { sha256: hashPrivateText(response).sha256, characters: response.length } }),
			protocolErrors: 0,
		},
		verification: finalVerification.map((entry) => ({
			...entry,
			checks: entry.checks.map((check) => ({ ...check })),
		})),
		result: {
			outcome: outcome(state, comparison.changed.length, comparison.headChanged, comparison.scopeViolations.length),
		},
	};
	return createRunReceiptEnvelope(receipt);
}

const defaultReceiptDependencies: GoalReceiptDependencies = {
	takeSnapshot: takeWorkspaceSnapshot,
	readBaseline: readGoalBaseline,
	receiptPath: (runId, workspaceRoot) => getWorkspaceReceiptPath(getAgentDir(), workspaceRoot, runId),
	writeReceipt: writeRunReceipt,
};

export async function writeGoalReceipt(
	state: GoalLoopState,
	dependencies: GoalReceiptDependencies = defaultReceiptDependencies,
): Promise<string> {
	const before = await dependencies.readBaseline(state.baselinePath);
	const after = await dependencies.takeSnapshot(state.workspaceRoot);
	const receiptPath = dependencies.receiptPath(state.runId, state.workspaceRoot);
	await dependencies.writeReceipt(receiptPath, createGoalReceipt(state, before, after, new Date(state.updatedAt)));
	return receiptPath;
}
