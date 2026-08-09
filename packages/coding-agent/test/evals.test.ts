import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { INFRASTRUCTURE_SMOKE_CASES, runInfrastructureSmoke } from "../src/extensions/evals/cases.ts";
import { createEvalsExtension } from "../src/extensions/evals/index.ts";
import { compareEvalReports, scoreEvalCase } from "../src/extensions/evals/scorer.ts";
import { EvalReportStore } from "../src/extensions/evals/store.ts";
import type { EvalCase, EvalReport } from "../src/extensions/evals/types.ts";
import type { RunRecord } from "../src/extensions/run-metrics/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		version: 2,
		id: "run-1",
		startedAt: "2026-08-09T00:00:00.000Z",
		durationMs: 100,
		turns: 1,
		retries: 0,
		taskKind: "code_change",
		outcome: "verified",
		tools: { edit: { calls: 1, errors: 0 }, verify: { calls: 1, errors: 0 } },
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0.001 },
		evidence: { verification: "passed", checks: 1 },
		...overrides,
	};
}

function report(id: string, passed: boolean, totalTokens: number): EvalReport {
	return {
		version: 1,
		id,
		createdAt: "2026-08-09T00:00:00.000Z",
		suiteId: "infrastructure-smoke-v1",
		candidate: { label: id, digest: id.padEnd(64, "0") },
		environment: { platform: "win32", arch: "x64", node: "v24" },
		cases: [
			{
				id: "case-1",
				title: "case",
				category: "verification",
				passed,
				failures: passed ? [] : ["未通过"],
				metrics: { durationMs: 100, totalTokens, toolCalls: 2, toolErrors: 0, retries: 0 },
			},
		],
		summary: {
			total: 1,
			passed: passed ? 1 : 0,
			failed: passed ? 0 : 1,
			successRate: passed ? 1 : 0,
			durationMs: 100,
			totalTokens,
			p50DurationMs: 100,
			p95DurationMs: 100,
			toolCalls: 2,
			toolErrors: 0,
			retries: 0,
		},
	};
}

describe("deterministic evaluation scorer", () => {
	it("runs ten stable offline infrastructure smoke cases", () => {
		const first = runInfrastructureSmoke(new Date("2026-08-09T00:00:00.000Z"));
		const second = runInfrastructureSmoke(new Date("2026-08-09T00:00:00.000Z"));
		expect(INFRASTRUCTURE_SMOKE_CASES).toHaveLength(10);
		expect(first.summary).toMatchObject({ total: 10, passed: 10, failed: 0, successRate: 1 });
		expect(second).toEqual(first);
	});

	it("detects verification, token, and tool-error failures", () => {
		const testCase: EvalCase = {
			id: "guard",
			title: "guard",
			category: "verification",
			expect: {
				outcomes: ["verified"],
				verification: "passed",
				maxTokens: 100,
				maxToolErrors: 0,
				requiredTools: ["verify"],
			},
		};
		const result = scoreEvalCase(testCase, {
			caseId: "guard",
			run: run({
				outcome: "unverified",
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0 },
				tools: { verify: { calls: 1, errors: 1 } },
				evidence: { verification: "missing", checks: 0 },
			}),
		});
		expect(result.passed).toBe(false);
		expect(result.failures).toHaveLength(4);
	});

	it("rejects a candidate with a case regression", () => {
		const comparison = compareEvalReports(report("baseline", true, 100), report("candidate", false, 80));
		expect(comparison.passed).toBe(false);
		expect(comparison.regressions).toEqual(["case-1"]);
	});

	it("rejects reports from different suites", () => {
		const baseline = report("baseline", true, 100);
		const candidate = { ...report("candidate", true, 90), suiteId: "different-suite" };
		const comparison = compareEvalReports(baseline, candidate);
		expect(comparison.passed).toBe(false);
		expect(comparison.reasons).toContain("评测套件不一致");
	});
});

describe("evaluation report store", () => {
	it("persists reports and an atomic baseline while skipping damaged lines", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-evals-"));
		temporaryDirectories.push(directory);
		const store = new EvalReportStore(directory);
		const value = report("candidate", true, 100);
		await store.append(value);
		await appendFile(
			path.join(directory, "reports.jsonl"),
			'damaged\n{"version":1,"id":"broken","createdAt":"now","suiteId":"suite","candidate":{"label":"x","digest":"x"},"environment":{"platform":"win32","arch":"x64","node":"v24"},"cases":[{}],"summary":{}}\n',
			"utf8",
		);
		await store.saveBaseline(value);
		expect(await store.read()).toEqual([value]);
		expect(await store.readBaseline()).toEqual(value);
	});
});

describe("evaluation command", () => {
	it("runs only the local smoke suite and explains its limit", async () => {
		const reports: EvalReport[] = [];
		let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		createEvalsExtension(
			{
				append: async (value) => {
					reports.push(value);
				},
				read: async () => reports,
				saveBaseline: async () => {},
				readBaseline: async () => undefined,
			},
			() => new Date("2026-08-09T00:00:00.000Z"),
		)({
			registerCommand: (
				_name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => {
				command = options.handler;
			},
			registerTool: () => {},
			on: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			sendUserMessage: () => {},
		} as unknown as ExtensionAPI);
		const notifications: string[] = [];
		if (!command) throw new Error("evals command was not registered");
		await command("run", {
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext);
		expect(reports).toHaveLength(1);
		expect(notifications.join("\n")).toContain("10/10");
		expect(notifications.join("\n")).toContain("不代表代理能力提升");
	});
});
