import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRunMetrics } from "../src/extensions/run-metrics/report.ts";
import { RunMetricsStore } from "../src/extensions/run-metrics/store.ts";
import { RunMetricsTracker } from "../src/extensions/run-metrics/tracker.ts";
import type { RunMetricRecord } from "../src/extensions/run-metrics/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function record(outcome: RunMetricRecord["outcome"], tools: RunMetricRecord["tools"]): RunMetricRecord {
	return {
		version: 1,
		startedAt: "2026-08-09T00:00:00.000Z",
		durationMs: 100,
		turns: 2,
		taskKind: outcome === "completed" ? "read_only" : "code_change",
		outcome,
		tools,
	};
}

describe("run metrics tracker", () => {
	it("records a verified code run without retaining tool input", () => {
		const tracker = new RunMetricsTracker();
		tracker.start(1_000);
		tracker.recordTool({
			toolName: "edit",
			input: { path: "secret/project/user.ts", oldText: "private source" },
			details: undefined,
			isError: false,
		});
		tracker.recordTool({
			toolName: "verify",
			input: { path: "secret/project/user.ts" },
			details: { passed: true, checks: [{ status: "passed" }] },
			isError: false,
		});
		tracker.recordTurn();

		const result = tracker.finish(1_250);
		expect(result).toMatchObject({
			durationMs: 250,
			turns: 1,
			taskKind: "code_change",
			outcome: "verified",
			tools: { edit: { calls: 1, errors: 0 }, verify: { calls: 1, errors: 0 } },
		});
		expect(JSON.stringify(result)).not.toContain("secret/project");
		expect(JSON.stringify(result)).not.toContain("private source");
	});

	it("does not count stale verification after another edit", () => {
		const tracker = new RunMetricsTracker();
		tracker.start(1_000);
		tracker.recordTool({ toolName: "write", input: { path: "main.py" }, details: undefined, isError: false });
		tracker.recordTool({ toolName: "verify", input: {}, details: { passed: true, checks: [] }, isError: false });
		tracker.recordTool({ toolName: "edit", input: { path: "main.py" }, details: undefined, isError: false });
		expect(tracker.finish(1_100)?.outcome).toBe("unverified");
	});
});

describe("run metrics store and report", () => {
	it("persists valid JSONL and skips damaged lines", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-run-metrics-"));
		temporaryDirectories.push(directory);
		const store = new RunMetricsStore(path.join(directory, "metrics", "runs.jsonl"));
		await store.append(record("verified", { edit: { calls: 1, errors: 0 }, verify: { calls: 1, errors: 0 } }));
		await store.append(record("failed", { edit: { calls: 1, errors: 0 }, verify: { calls: 1, errors: 1 } }));

		const records = await store.read();
		expect(records).toHaveLength(2);
		expect(records[0]?.outcome).toBe("verified");
	});

	it("shows usage correlation and a privacy warning", () => {
		const report = formatRunMetrics([
			record("verified", { lsp: { calls: 2, errors: 0 } }),
			record("failed", { lsp: { calls: 1, errors: 1 } }),
			record("completed", { read: { calls: 1, errors: 0 } }),
		]);

		expect(report).toContain("lsp");
		expect(report).toContain("相关差值");
		expect(report).toContain("不代表工具与成功之间存在因果关系");
		expect(report).toContain("不包含提示、代码、路径或输出");
	});
});
