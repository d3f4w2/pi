import { describe, expect, it } from "vitest";
import {
	formatGoalControlTitle,
	GOAL_RUN_PRESETS,
	goalControlOptions,
	goalStartArgumentsForPreset,
} from "../src/extensions/goal-loop/control.ts";
import { createGoalLoopState } from "../src/extensions/goal-loop/state.ts";
import type { GoalLoopState, GoalLoopStatus } from "../src/extensions/goal-loop/types.ts";

const now = "2026-08-12T00:00:00.000Z";

function state(status: GoalLoopStatus): GoalLoopState {
	const value = createGoalLoopState(
		{
			goal: "升级解析器",
			scope: ["."],
			verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
			budget: { timeoutSeconds: 7200, maxTokens: 400_000, maxToolCalls: 400, maxIterations: 12 },
		},
		{ runId: "run-1", workspaceRoot: "C:/repo", baselinePath: "C:/state/baseline.json", now },
	);
	value.status = status;
	if (["verified", "budget_exhausted", "stopped", "failed"].includes(status)) {
		value.receiptPath = "C:/agent/runs/run-1.json";
	}
	return value;
}

function actionIds(value: GoalLoopState | undefined): string[] {
	return goalControlOptions(value).map((option) => option.id);
}

describe("goal loop single-entry control model", () => {
	it("shows only legal actions for each lifecycle state", () => {
		expect(actionIds(undefined)).toEqual(["start", "help", "close"]);
		expect(actionIds(state("running"))).toEqual(["status", "pause", "stop", "close"]);
		expect(actionIds(state("verifying"))).toEqual(["status", "pause", "stop", "close"]);
		expect(actionIds(state("paused"))).toEqual(["status", "resume", "stop", "close"]);
		expect(actionIds(state("waiting_user"))).toEqual(["status", "decide", "stop", "close"]);
		expect(actionIds(state("stuck"))).toEqual(["status", "decide", "stop", "close"]);
		expect(actionIds(state("verified"))).toEqual(["status", "accept", "start", "close"]);
		expect(actionIds(state("budget_exhausted"))).toEqual(["status", "accept", "start", "close"]);
		const terminalWithoutReceipt = state("verified");
		delete terminalWithoutReceipt.receiptPath;
		expect(actionIds(terminalWithoutReceipt)).toEqual(["status", "retry_receipt", "close"]);
	});

	it("offers bounded quick, standard, and long-run presets", () => {
		expect(GOAL_RUN_PRESETS.map((preset) => preset.id)).toEqual(["quick", "standard", "long"]);
		expect(goalStartArgumentsForPreset("修复一个回归", "quick").budget).toEqual({
			timeoutSeconds: 1800,
			maxTokens: 200_000,
			maxToolCalls: 200,
			maxIterations: 8,
		});
		expect(goalStartArgumentsForPreset("完成迁移", "long").budget).toEqual({
			timeoutSeconds: 28_800,
			maxTokens: 1_000_000,
			maxToolCalls: 1_000,
			maxIterations: 32,
		});
	});

	it("summarizes state and remaining wall time in the control title", () => {
		const value = state("paused");
		value.iteration = 3;
		expect(formatGoalControlTitle(value, Date.parse(now) + 30_000)).toBe(
			"Pigo 工程执行 · 已暂停 · 第 3/12 轮 · 剩余 1:59:30",
		);
		expect(formatGoalControlTitle(undefined, Date.parse(now))).toBe("Pigo 工程执行 · 当前没有目标");
	});
});
