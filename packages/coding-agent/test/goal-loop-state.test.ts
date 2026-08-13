import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	applyGoalVerification,
	buildGoalIterationPrompt,
	createGoalLoopState,
	fingerprintGoalGap,
	formatGoalLoopStatus,
	goalBudgetBreach,
	loadLatestGoalLoopState,
	normalizeGoalStartArguments,
	parseGoalLoopCommand,
	pauseGoalLoop,
	recordGoalUsage,
	recordGoalVerificationEvidence,
	resumeGoalLoop,
	setGoalReceiptError,
	setGoalReport,
} from "../src/extensions/goal-loop/state.ts";
import { GOAL_LOOP_ENTRY_TYPE } from "../src/extensions/goal-loop/types.ts";

const now = "2026-08-12T00:00:00.000Z";

function createState() {
	return createGoalLoopState(
		{
			goal: "修复解析器并补测试",
			scope: ["."],
			verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
			budget: { timeoutSeconds: 7200, maxTokens: 400_000, maxToolCalls: 400, maxIterations: 12 },
		},
		{ runId: "run-1", workspaceRoot: "C:/repo", baselinePath: "C:/state/baseline.json", now },
	);
}

const passingEvidence = [
	{
		operation: "auto" as const,
		path: ".",
		passed: true,
		durationMs: 10,
		checks: [{ id: "test" as const, status: "passed" as const, durationMs: 10 }],
	},
];

describe("goal loop command parser", () => {
	it("parses a natural-language goal and bounded overrides", () => {
		const parsed = parseGoalLoopCommand(
			'--timeout 3600 --max-iterations=6 --scope src --verify test:test "修复 parser 并补测试"',
		);
		expect(parsed).toMatchObject({
			action: "start",
			arguments: {
				goal: "修复 parser 并补测试",
				scope: ["src"],
				verification: [{ operation: "test", path: "test", timeoutSeconds: 60 }],
				budget: { timeoutSeconds: 3600, maxIterations: 6 },
			},
		});
	});

	it("uses empty input for the control center and treats former verbs as goal text", () => {
		expect(parseGoalLoopCommand("")).toEqual({ action: "control" });
		expect(parseGoalLoopCommand("status")).toMatchObject({ action: "start", arguments: { goal: "status" } });
		expect(parseGoalLoopCommand("-- status")).toMatchObject({ action: "start", arguments: { goal: "status" } });
		expect(parseGoalLoopCommand("resume 采用兼容方案")).toMatchObject({
			action: "start",
			arguments: { goal: "resume 采用兼容方案" },
		});
	});

	it("rejects unknown options, out-of-range budgets, and unterminated quotes", () => {
		expect(() => parseGoalLoopCommand("--forever 修复")).toThrow("未知选项");
		expect(() => parseGoalLoopCommand("--max-iterations 0 修复")).toThrow("1 到 64");
		expect(() => parseGoalLoopCommand('"修复')).toThrow("未闭合");
	});

	it("deduplicates checks and bounds the frozen contract size", () => {
		const parsed = parseGoalLoopCommand("--verify auto:. --verify auto:. 修复");
		if (parsed.action !== "start") throw new Error("expected start");
		expect(parsed.arguments.verification).toHaveLength(1);
		expect(() => parseGoalLoopCommand(`${"--verify auto:. ".repeat(17)}修复`)).toThrow("最多可提供 16 次");
	});
});

describe("goal loop state machine", () => {
	it("marks a completed report verified only after checks and workspace compliance pass", () => {
		let state = createState();
		state = setGoalReport(state, { status: "complete", summary: "实现与测试完成" }, now);
		state.status = "verifying";
		state = applyGoalVerification(state, {
			evidence: passingEvidence,
			workspaceDigest: "digest-1",
			workspaceCompliance: { headChanged: false, scopeViolations: ["outside.ts"] },
			gap: "存在范围外修改：outside.ts",
			finishedAt: "2026-08-12T00:01:00.000Z",
		});
		expect(state.status).toBe("running");
		expect(state.iterations[0]?.workspaceCompliance?.scopeViolations).toEqual(["outside.ts"]);

		state = setGoalReport(state, { status: "complete", summary: "范围外修改已撤销" }, state.updatedAt);
		state.status = "verifying";
		state = applyGoalVerification(state, {
			evidence: passingEvidence,
			workspaceDigest: "digest-2",
			workspaceCompliance: { headChanged: false, scopeViolations: [] },
			gap: "",
			finishedAt: "2026-08-12T00:02:00.000Z",
		});
		expect(state.status).toBe("verified");
		expect(state.reason).toContain("独立验证全部通过");
	});

	it("replans after a failed check and stops on an unchanged repeated gap", () => {
		let state = createState();
		state = setGoalReport(state, { status: "continue", summary: "仍在修复", gap: "测试失败" }, now);
		state.status = "verifying";
		const failed = {
			evidence: [
				{
					...passingEvidence[0],
					passed: false,
					checks: [{ ...passingEvidence[0].checks[0], status: "failed" as const }],
				},
			],
			workspaceDigest: "same-digest",
			workspaceCompliance: { headChanged: false, scopeViolations: [] },
			gap: "test/parser.test.ts:20 expected 2 received 1",
			finishedAt: "2026-08-12T00:01:00.000Z",
		};
		state = applyGoalVerification(state, failed);
		expect(state.status).toBe("running");
		expect(state.iteration).toBe(2);

		state = setGoalReport(state, { status: "continue", summary: "再次尝试", gap: "同一测试失败" }, failed.finishedAt);
		state.status = "verifying";
		state = applyGoalVerification(state, { ...failed, finishedAt: "2026-08-12T00:02:00.000Z" });
		expect(state.status).toBe("stuck");
		expect(state.repeatedGapCount).toBe(2);
		expect(() => resumeGoalLoop(state, undefined, "2026-08-12T00:03:00.000Z")).toThrow("需要具体决策");
		expect(resumeGoalLoop(state, "改用兼容实现", "2026-08-12T00:03:00.000Z").status).toBe("running");
	});

	it("preserves verifier evidence before a safe-boundary pause and resumes in a new iteration", () => {
		let state = createState();
		state = setGoalReport(state, { status: "continue", summary: "已修复一部分", gap: "还差一个测试" }, now);
		state.status = "verifying";
		state = recordGoalVerificationEvidence(state, {
			evidence: passingEvidence,
			workspaceDigest: "digest-pause",
			workspaceCompliance: { headChanged: false, scopeViolations: [] },
			gap: "等待暂停后继续",
			finishedAt: "2026-08-12T00:01:00.000Z",
		});
		state = pauseGoalLoop(state, "用户请求暂停", "2026-08-12T00:01:01.000Z");
		expect(state.iterations[0]?.verification).toEqual(passingEvidence);
		state = resumeGoalLoop(state, undefined, "2026-08-12T00:02:00.000Z");
		expect(state.iteration).toBe(2);
		expect(state.iterations[1]?.verification).toEqual([]);
	});

	it("resumes a reported Agent turn at its pending verification boundary", () => {
		let state = createState();
		state = setGoalReport(state, { status: "continue", summary: "已完成第一种实现", gap: "仍需验证" }, now);
		state = pauseGoalLoop(state, "用户请求暂停", "2026-08-12T00:00:30.000Z");

		state = resumeGoalLoop(state, undefined, "2026-08-12T00:01:00.000Z");

		expect(state.status).toBe("verifying");
		expect(state.iteration).toBe(1);
		expect(state.iterations[0]?.report?.summary).toBe("已完成第一种实现");
	});

	it("does not exceed the frozen iteration budget when resuming after verification", () => {
		let state = createState();
		state.budget.maxIterations = 1;
		state.status = "paused";
		state.iterations[0]!.finishedAt = "2026-08-12T00:00:30.000Z";

		state = resumeGoalLoop(state, undefined, "2026-08-12T00:01:00.000Z");

		expect(state).toMatchObject({ status: "budget_exhausted", iteration: 1, reason: "iteration_budget" });
	});

	it("feeds recent evidence back into the next replan without changing frozen acceptance", () => {
		let state = createState();
		state = setGoalReport(state, { status: "continue", summary: "尝试了递归下降解析", gap: "边界测试失败" }, now);
		state.status = "verifying";
		state = applyGoalVerification(state, {
			evidence: [{ ...passingEvidence[0]!, passed: false }],
			workspaceDigest: "digest-replan",
			workspaceCompliance: { headChanged: false, scopeViolations: [] },
			gap: "嵌套括号测试仍失败",
			finishedAt: "2026-08-12T00:01:00.000Z",
		});
		const prompt = buildGoalIterationPrompt(state);
		expect(prompt).toContain("尝试了递归下降解析");
		expect(prompt).toContain("嵌套括号测试仍失败");
		expect(prompt).toContain("冻结验收：auto:.");
		expect(prompt).toContain("不要在证据未变化时重复同一方案");
	});

	it("waits for one concrete user decision without pretending verification completed", () => {
		let state = createState();
		state = setGoalReport(
			state,
			{ status: "needs_user", summary: "存在两种公开 API", question: "是否允许移除旧 API？" },
			now,
		);
		state.status = "verifying";
		state = applyGoalVerification(state, {
			evidence: passingEvidence,
			workspaceDigest: "digest-2",
			workspaceCompliance: { headChanged: false, scopeViolations: [] },
			gap: "",
			finishedAt: "2026-08-12T00:01:00.000Z",
		});
		expect(state.status).toBe("waiting_user");
		expect(state.reason).toBe("是否允许移除旧 API？");
	});

	it("accepts only one structured report per iteration", () => {
		const state = setGoalReport(createState(), { status: "continue", summary: "正在修复", gap: "仍有失败" }, now);
		expect(() =>
			setGoalReport(state, { status: "complete", summary: "试图覆盖第一次报告" }, "2026-08-12T00:00:01.000Z"),
		).toThrow("已经提交");
	});

	it("enforces aggregate wall, token, tool, and iteration budgets", () => {
		const state = createState();
		expect(goalBudgetBreach(state, Date.parse(now) + 7_200_000)).toBe("timeout");
		state.metrics.usage.totalTokens = 400_000;
		expect(goalBudgetBreach(state, Date.parse(now))).toBe("token_budget");
		state.metrics.usage.totalTokens = 0;
		state.metrics.toolCalls = { read: 400 };
		expect(goalBudgetBreach(state, Date.parse(now))).toBe("tool_budget");
		state.metrics.toolCalls = {};
		state.iteration = 12;
		expect(goalBudgetBreach(state, Date.parse(now))).toBe("iteration_budget");
	});

	it("counts compaction usage without inventing another Agent turn", () => {
		const state = recordGoalUsage(
			createState(),
			{
				input: 800,
				output: 200,
				cacheRead: 100,
				cacheWrite: 0,
				totalTokens: 1_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			},
			"2026-08-12T00:01:00.000Z",
		);
		expect(state.metrics.turns).toBe(0);
		expect(state.metrics.usage).toMatchObject({ totalTokens: 1_000, cost: 0.01 });
	});

	it("ignores non-finite usage observations instead of corrupting aggregate budgets", () => {
		const state = recordGoalUsage(
			createState(),
			{
				input: 800,
				output: 200,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: Number.NaN,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.POSITIVE_INFINITY },
			},
			"2026-08-12T00:01:00.000Z",
		);

		expect(state.metrics.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 });
	});

	it("records receipt retry errors without moving the terminal execution time", () => {
		const state = createState();
		state.status = "verified";
		state.updatedAt = "2026-08-12T00:02:00.000Z";

		const next = setGoalReceiptError(state, "temporary lock", "2026-08-12T00:03:00.000Z");

		expect(next).toMatchObject({
			status: "verified",
			updatedAt: "2026-08-12T00:02:00.000Z",
			receiptError: "temporary lock",
			revision: state.revision + 1,
		});
	});

	it("shows remaining wall budget and latest independent evidence in status", () => {
		const state = createState();
		state.status = "paused";
		state.metrics.usage.totalTokens = 40_000;
		state.metrics.toolCalls = { read: 20, edit: 5 };
		state.iterations[0]!.verification = passingEvidence;
		const text = formatGoalLoopStatus(state, Date.parse(now) + 1_800_000);
		expect(text).toContain("已暂停");
		expect(text).toContain("已用 0:30:00 · 剩余 1:30:00");
		expect(text).toContain("40000/400000 tokens (10.0%)");
		expect(text).toContain("25/400 tools (6.3%)");
		expect(text).toContain("验收：1/1 通过");
	});

	it("normalizes paths and rejects scope or verification escape", () => {
		const parsed = parseGoalLoopCommand("--scope src --verify auto:src 修复");
		if (parsed.action !== "start") throw new Error("expected start");
		expect(normalizeGoalStartArguments(parsed.arguments, "C:/repo")).toMatchObject({
			scope: ["src"],
			verification: [{ path: "src" }],
		});
		expect(() => normalizeGoalStartArguments({ ...parsed.arguments, scope: ["../outside"] }, "C:/repo")).toThrow(
			"当前 Git 工作区",
		);
	});

	it("restores only a valid latest branch checkpoint", () => {
		const state = createState();
		const entries = [
			{ type: "custom", id: "good", parentId: null, timestamp: now, customType: GOAL_LOOP_ENTRY_TYPE, data: state },
			{
				type: "custom",
				id: "bad-status",
				parentId: "good",
				timestamp: now,
				customType: GOAL_LOOP_ENTRY_TYPE,
				data: { ...state, status: "corrupt" },
			},
			{
				type: "custom",
				id: "bad-metrics",
				parentId: "bad-status",
				timestamp: now,
				customType: GOAL_LOOP_ENTRY_TYPE,
				data: { ...state, metrics: { turns: 0 } },
			},
		] as SessionEntry[];
		expect(loadLatestGoalLoopState(entries)).toEqual(state);
	});

	it("uses the workspace digest in the stuck fingerprint", () => {
		expect(fingerprintGoalGap("expected 2", "a")).not.toBe(fingerprintGoalGap("expected 2", "b"));
		expect(fingerprintGoalGap("expected 2", "a")).toBe(fingerprintGoalGap("expected 3", "a"));
	});
});
