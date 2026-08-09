import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	createEmptyTaskLedger,
	loadLatestTaskLedgerState,
	reduceTaskLedger,
} from "../src/extensions/task-ledger/state.ts";
import { TASK_LEDGER_ENTRY_TYPE, type TaskLedgerState } from "../src/extensions/task-ledger/types.ts";

function createPlan(): TaskLedgerState {
	return reduceTaskLedger(createEmptyTaskLedger(), {
		operation: "set_plan",
		expected_revision: 0,
		phases: [
			{ title: "实现", tasks: ["写状态机", "接入扩展"] },
			{ title: "验证", tasks: ["运行测试"] },
		],
	});
}

function customEntry(id: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-08-09T00:00:00.000Z",
		customType: TASK_LEDGER_ENTRY_TYPE,
		data,
	} satisfies SessionEntry;
}

describe("task ledger state", () => {
	it("creates stable IDs and starts the first task", () => {
		const state = createPlan();

		expect(state.revision).toBe(1);
		expect(state.phases.map((phase) => phase.id)).toEqual(["p1", "p2"]);
		expect(state.phases.flatMap((phase) => phase.tasks.map((task) => task.id))).toEqual(["t1", "t2", "t3"]);
		expect(state.phases[0]?.tasks[0]?.status).toBe("in_progress");
		expect(state.phases[0]?.tasks[1]?.status).toBe("pending");
	});

	it("requires completion evidence and advances exactly one task", () => {
		const state = createPlan();

		expect(() =>
			reduceTaskLedger(state, { operation: "complete", expected_revision: 1, task_id: "t1", evidence: "  " }),
		).toThrow("完成证据");
		expect(state.revision).toBe(1);
		expect(state.phases[0]?.tasks[0]?.status).toBe("in_progress");

		const next = reduceTaskLedger(state, {
			operation: "complete",
			expected_revision: 1,
			task_id: "t1",
			evidence: "npm run check 通过\n无错误",
		});
		expect(next.revision).toBe(2);
		expect(next.phases[0]?.tasks[0]).toMatchObject({ status: "completed", evidence: "npm run check 通过 无错误" });
		expect(next.phases[0]?.tasks[1]?.status).toBe("in_progress");
	});

	it("rejects stale revisions without mutating the input", () => {
		const state = createPlan();

		expect(() => reduceTaskLedger(state, { operation: "start", expected_revision: 0, task_id: "t2" })).toThrow(
			"当前 revision 为 1",
		);
		expect(state.phases[0]?.tasks.map((task) => task.status)).toEqual(["in_progress", "pending"]);
	});

	it("supports blocking, unblocking, abandoning, reopening, and removal", () => {
		let state = createPlan();
		state = reduceTaskLedger(state, {
			operation: "block",
			expected_revision: 1,
			task_id: "t1",
			reason: "等待接口",
		});
		expect(state.phases[0]?.tasks[0]).toMatchObject({ status: "blocked", blocker: "等待接口" });
		expect(state.phases[0]?.tasks[1]?.status).toBe("in_progress");

		state = reduceTaskLedger(state, { operation: "unblock", expected_revision: 2, task_id: "t1" });
		expect(state.phases[0]?.tasks[0]?.status).toBe("pending");
		state = reduceTaskLedger(state, { operation: "abandon", expected_revision: 3, task_id: "t2" });
		expect(state.phases[0]?.tasks[0]?.status).toBe("in_progress");
		state = reduceTaskLedger(state, { operation: "reopen", expected_revision: 4, task_id: "t2" });
		expect(state.phases[0]?.tasks[1]?.status).toBe("pending");
		state = reduceTaskLedger(state, { operation: "remove", expected_revision: 5, task_id: "t3" });
		expect(state.phases.map((phase) => phase.title)).toEqual(["实现"]);
	});

	it("keeps IDs monotonic after clear and plan replacement", () => {
		let state = createPlan();
		state = reduceTaskLedger(state, { operation: "clear", expected_revision: 1 });
		state = reduceTaskLedger(state, {
			operation: "set_plan",
			expected_revision: 2,
			phases: [{ title: "新计划", tasks: ["新任务"] }],
		});

		expect(state.phases[0]?.id).toBe("p3");
		expect(state.phases[0]?.tasks[0]?.id).toBe("t4");
	});

	it("rejects duplicate phases and oversized plans", () => {
		expect(() =>
			reduceTaskLedger(createEmptyTaskLedger(), {
				operation: "set_plan",
				expected_revision: 0,
				phases: [
					{ title: "实现", tasks: ["一"] },
					{ title: " 实现 ", tasks: ["二"] },
				],
			}),
		).toThrow("阶段名称不能重复");

		expect(() =>
			reduceTaskLedger(createEmptyTaskLedger(), {
				operation: "set_plan",
				expected_revision: 0,
				phases: [{ title: "过大", tasks: Array.from({ length: 101 }, (_, index) => `任务 ${index}`) }],
			}),
		).toThrow("最多 100 个任务");
	});

	it("restores the newest valid branch snapshot and skips corrupt data", () => {
		const state = createPlan();
		const logicallyCorrupt = structuredClone(state);
		if (logicallyCorrupt.phases[0]?.tasks[1]) logicallyCorrupt.phases[0].tasks[1].status = "in_progress";
		const entries = [
			customEntry("valid", state),
			customEntry("logically-corrupt", logicallyCorrupt),
			customEntry("corrupt", { schemaVersion: 1, revision: "bad" }),
		];

		expect(loadLatestTaskLedgerState(entries)).toEqual(state);
		expect(loadLatestTaskLedgerState([])).toEqual(createEmptyTaskLedger());
	});
});
