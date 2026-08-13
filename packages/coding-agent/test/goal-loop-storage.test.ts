import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRunReceiptText, writeRunReceipt } from "../src/cli/run-receipt.ts";
import type { WorkspaceSnapshot } from "../src/cli/run-workspace.ts";
import { createGoalLoopState } from "../src/extensions/goal-loop/state.ts";
import {
	createGoalReceipt,
	readGoalBaseline,
	writeGoalBaseline,
	writeGoalReceipt,
} from "../src/extensions/goal-loop/storage.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pigo-goal-storage-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function snapshot(root: string, digest: string, dirty: ReadonlyMap<string, string> = new Map()): WorkspaceSnapshot {
	return {
		root,
		head: "a".repeat(40),
		digest,
		coverage: "git-tracked-and-unignored",
		index: new Map([["src/main.ts", "100644:blob-a"]]),
		dirty,
	};
}

function verifiedState(root: string, baselinePath: string) {
	const state = createGoalLoopState(
		{
			goal: "修复 main 并补测试",
			scope: ["."],
			verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
			budget: { timeoutSeconds: 7200, maxTokens: 400_000, maxToolCalls: 400, maxIterations: 12 },
		},
		{
			runId: "goal-run-1",
			workspaceRoot: root,
			baselinePath,
			now: "2026-08-12T00:00:00.000Z",
		},
	);
	state.status = "verified";
	state.metrics.turns = 2;
	state.metrics.toolCalls = { read: 2, edit: 1, goal_report: 1 };
	state.metrics.usage.totalTokens = 1200;
	state.iterations[0]!.finishedAt = "2026-08-12T00:02:00.000Z";
	state.iterations[0]!.verification = [
		{
			operation: "auto",
			path: ".",
			passed: true,
			durationMs: 25,
			checks: [{ id: "test", status: "passed", durationMs: 25, command: "npm test" }],
		},
	];
	return state;
}

describe("goal loop storage", () => {
	it("round-trips a private Git baseline with maps intact", async () => {
		const directory = await temporaryDirectory();
		const before = snapshot("C:/repo", "b".repeat(64), new Map([["src/main.ts", "dirty-a"]]));
		const baselinePath = await writeGoalBaseline(directory, "run-1", before);
		const restored = await readGoalBaseline(baselinePath);

		expect(restored).toMatchObject({ root: "C:/repo", digest: "b".repeat(64) });
		expect([...restored.index.entries()]).toEqual([...before.index.entries()]);
		expect([...restored.dirty.entries()]).toEqual([...before.dirty.entries()]);
	});

	it("creates a valid privacy-safe receipt for a verified interactive run", async () => {
		const before = snapshot("C:/repo", "b".repeat(64));
		const after = snapshot("C:/repo", "c".repeat(64), new Map([["src/main.ts", "dirty-b"]]));
		const envelope = createGoalReceipt(
			verifiedState("C:/repo", "C:/state/baseline.json"),
			before,
			after,
			new Date("2026-08-12T00:02:00.000Z"),
		);

		expect(envelope.receipt.result.outcome).toBe("verified");
		expect(envelope.receipt.contract.task).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(JSON.stringify(envelope)).not.toContain("修复 main 并补测试");
		expect(verifyRunReceiptText(JSON.stringify(envelope))).toEqual(envelope);
	});

	it("writes a terminal receipt through injected snapshot and storage dependencies", async () => {
		const directory = await temporaryDirectory();
		const before = snapshot("C:/repo", "b".repeat(64));
		const after = snapshot("C:/repo", "c".repeat(64), new Map([["src/main.ts", "dirty-b"]]));
		const baselinePath = await writeGoalBaseline(directory, "goal-run-1", before);
		const receiptPath = path.join(directory, "receipt.json");
		const state = verifiedState("C:/repo", baselinePath);
		state.updatedAt = "2026-08-12T00:01:59.000Z";

		const dependencies = {
			takeSnapshot: async () => after,
			readBaseline: readGoalBaseline,
			receiptPath: () => receiptPath,
			writeReceipt: writeRunReceipt,
		};
		const written = await writeGoalReceipt(state, dependencies);
		await expect(writeGoalReceipt(state, dependencies)).resolves.toBe(receiptPath);

		expect(written).toBe(receiptPath);
		expect(verifyRunReceiptText(await readFile(receiptPath, "utf8")).receipt).toMatchObject({
			runId: "goal-run-1",
			finishedAt: "2026-08-12T00:01:59.000Z",
		});
	});

	it("records iteration-budget exhaustion and user stop as distinct terminal reasons", () => {
		const before = snapshot("C:/repo", "b".repeat(64));
		const after = snapshot("C:/repo", "c".repeat(64));
		const iterationBudget = verifiedState("C:/repo", "C:/state/baseline.json");
		iterationBudget.status = "budget_exhausted";
		iterationBudget.reason = "iteration_budget";
		const exhaustedEnvelope = createGoalReceipt(iterationBudget, before, after, new Date("2026-08-12T00:02:00.000Z"));
		expect(exhaustedEnvelope.receipt.execution.terminationReason).toBe("iteration_budget");
		expect(exhaustedEnvelope.receipt.result.outcome).toBe("noncompliant");
		expect(verifyRunReceiptText(JSON.stringify(exhaustedEnvelope))).toEqual(exhaustedEnvelope);

		const stopped = verifiedState("C:/repo", "C:/state/baseline.json");
		stopped.status = "stopped";
		const stoppedEnvelope = createGoalReceipt(stopped, before, after, new Date("2026-08-12T00:02:00.000Z"));
		expect(stoppedEnvelope.receipt.execution.terminationReason).toBe("user_stopped");
		expect(stoppedEnvelope.receipt.result.outcome).toBe("failed");
		expect(verifyRunReceiptText(JSON.stringify(stoppedEnvelope))).toEqual(stoppedEnvelope);
	});

	it("retains the latest independent evidence when a later unverified iteration stops", () => {
		const before = snapshot("C:/repo", "b".repeat(64));
		const after = snapshot("C:/repo", "c".repeat(64));
		const state = verifiedState("C:/repo", "C:/state/baseline.json");
		state.status = "stopped";
		state.iteration = 2;
		state.iterations.push({
			number: 2,
			startedAt: "2026-08-12T00:01:30.000Z",
			verification: [],
		});

		const envelope = createGoalReceipt(state, before, after, new Date("2026-08-12T00:02:00.000Z"));

		expect(envelope.receipt.verification).toEqual(state.iterations[0]?.verification);
		expect(envelope.receipt.execution.terminationReason).toBe("user_stopped");
	});
});
