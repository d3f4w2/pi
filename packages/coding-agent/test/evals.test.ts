import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { AGENT_EVAL_CASES } from "../src/extensions/evals/agent-cases.ts";
import {
	AGENT_EVAL_REPORT_ENTRY,
	type AgentEvalReportEntryData,
	createAgentEvalReportComponent,
} from "../src/extensions/evals/agent-report.ts";
import { INFRASTRUCTURE_SMOKE_CASES, runInfrastructureSmoke } from "../src/extensions/evals/cases.ts";
import { createEvalsExtension } from "../src/extensions/evals/index.ts";
import { compareEvalReports, scoreEvalCase } from "../src/extensions/evals/scorer.ts";
import { EvalReportStore } from "../src/extensions/evals/store.ts";
import type {
	AgentEvalCase,
	AgentEvalResult,
	AgentEvalRunOptions,
	ApprovedRegressionCase,
	EvalCase,
	EvalReport,
	RegressionCaseStoreLike,
} from "../src/extensions/evals/types.ts";
import type { RunRecord } from "../src/extensions/run-metrics/types.ts";
import { setLanguageSetting } from "../src/modes/interactive/i18n/index.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

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
		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
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
				name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => {
				commands.set(name, options.handler);
			},
			registerTool: () => {},
			registerEntryRenderer: () => {},
			on: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			sendUserMessage: () => {},
		} as unknown as ExtensionAPI);
		const notifications: string[] = [];
		const command = commands.get("evals-dev");
		if (!command) throw new Error("evals-dev command was not registered");
		await command("run", {
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext);
		expect(reports).toHaveLength(1);
		expect(notifications.join("\n")).toContain("10/10");
		expect(notifications.join("\n")).toContain("不代表代理能力提升");
	});

	it("opens one menu and runs the latest approved case", async () => {
		setLanguageSetting("zh-CN");
		const root = await mkdtemp(path.join(tmpdir(), "pi-evals-menu-"));
		temporaryDirectories.push(root);
		const relativePath = "test/latest.test.ts";
		const content = 'import test from "node:test";\ntest("latest", () => {});\n';
		await mkdir(path.join(root, "test"), { recursive: true });
		await writeFile(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
		await writeFile(path.join(root, relativePath), content, "utf8");
		const approved: ApprovedRegressionCase = {
			version: 1,
			id: "latest-case-id",
			title: "latest case",
			category: "testing",
			approvedAt: "2026-08-09T00:00:00.000Z",
			source: {
				fingerprint: "failure",
				kind: "tool_error",
				summary: "recovered",
				detectedAt: "2026-08-09T00:00:00.000Z",
				recoveredAt: "2026-08-09T00:00:01.000Z",
			},
			reproduction: ["fail once"],
			expectedFailure: "fails",
			expectedSuccess: "passes",
			files: [
				{
					path: relativePath,
					bytes: Buffer.byteLength(content, "utf8"),
					digest: createHash("sha256").update(content).digest("hex"),
				},
			],
		};
		const regressionStore: RegressionCaseStoreLike = {
			isSuppressed: async () => false,
			suppress: async () => {},
			saveApproved: async () => {},
			listApproved: async () => [approved],
		};
		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		const execute = vi.fn(async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }));
		createEvalsExtension(
			{
				append: async () => {},
				read: async () => [],
				saveBaseline: async () => {},
				readBaseline: async () => undefined,
			},
			() => new Date("2026-08-09T00:00:00.000Z"),
			regressionStore,
		)({
			registerCommand: (
				name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => {
				commands.set(name, options.handler);
			},
			registerTool: () => {},
			registerEntryRenderer: () => {},
			on: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			sendUserMessage: () => {},
			exec: execute,
		} as unknown as ExtensionAPI);
		const command = commands.get("tests");
		if (!command) throw new Error("tests command was not registered");
		const notifications: string[] = [];
		await command("", {
			hasUI: true,
			cwd: root,
			signal: undefined,
			ui: {
				select: async () => "运行最近案例",
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
			},
		} as unknown as ExtensionCommandContext);
		expect(execute).toHaveBeenCalledOnce();
		expect(notifications.join("\n")).toContain("回归案例通过：latest-case-id");
	});

	it("keeps code tests, Agent evaluation, and evaluator self-checks separate", async () => {
		setLanguageSetting("zh-CN");
		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		const result: AgentEvalResult = {
			version: 1,
			id: "result-1",
			caseId: AGENT_EVAL_CASES[0]?.id ?? "missing",
			title: "找到真实定义",
			category: "navigation",
			createdAt: "2026-08-09T00:00:00.000Z",
			provider: "test-provider",
			model: "test-model",
			thinkingLevel: "medium",
			passed: true,
			timedOut: false,
			durationMs: 1_000,
			totalTokens: 100,
			toolCalls: 2,
			toolErrors: 0,
		};
		const runAgent = vi.fn(async (_testCase: AgentEvalCase, options: AgentEvalRunOptions) => {
			options.onProgress?.({ stage: "tool", toolName: "grep", toolCalls: 1 });
			return result;
		});
		const previousResult: AgentEvalResult = {
			...result,
			id: "result-previous",
			createdAt: "2026-08-08T00:00:00.000Z",
			durationMs: 1_500,
			totalTokens: 150,
			toolCalls: 3,
		};
		const saved: AgentEvalResult[] = [previousResult];
		const reportEntries: AgentEvalReportEntryData[] = [];
		const widgets: Array<string[] | undefined> = [];
		createEvalsExtension(
			{
				append: async () => {},
				read: async () => [],
				saveBaseline: async () => {},
				readBaseline: async () => undefined,
			},
			undefined,
			undefined,
			undefined,
			{ run: runAgent },
			{
				append: async (value) => {
					saved.push(value);
				},
				read: async () => saved,
			},
		)({
			registerCommand: (
				name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => {
				commands.set(name, options.handler);
			},
			registerTool: () => {},
			registerEntryRenderer: () => {},
			on: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			sendUserMessage: () => {},
			appendEntry: (type: string, data: AgentEvalReportEntryData | undefined) => {
				if (type === AGENT_EVAL_REPORT_ENTRY && data) reportEntries.push(data);
			},
		} as unknown as ExtensionAPI);
		expect([...commands.keys()]).toEqual(["tests", "evals", "evals-dev"]);
		const command = commands.get("evals");
		if (!command) throw new Error("evals command was not registered");
		await command(`case ${result.caseId}`, {
			hasUI: true,
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: "medium",
			ui: {
				confirm: async () => true,
				notify: () => {},
				setStatus: () => {},
				setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
			},
		} as unknown as ExtensionCommandContext);
		expect(runAgent).toHaveBeenCalledOnce();
		expect(saved).toEqual([previousResult, result]);
		expect(reportEntries).toEqual([
			{
				version: 1,
				createdAt: expect.any(String),
				results: [result],
				previousResults: [previousResult],
			},
		]);
		expect(widgets.some((content) => content?.join("\n").includes("Agent 正在使用 grep"))).toBe(true);
		expect(widgets.at(-1)).toBeUndefined();
	});

	it("shows the latest result with the previous run of the same case without a new command", async () => {
		const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
		const base: AgentEvalResult = {
			version: 1,
			id: "previous",
			caseId: "navigation-find-definition",
			title: "找到真实定义",
			category: "navigation",
			createdAt: "2026-08-08T00:00:00.000Z",
			provider: "provider",
			model: "model",
			thinkingLevel: "medium",
			passed: true,
			timedOut: false,
			durationMs: 2_000,
			totalTokens: 100,
			toolCalls: 2,
			toolErrors: 0,
		};
		const latest: AgentEvalResult = {
			...base,
			id: "latest",
			createdAt: "2026-08-09T00:00:00.000Z",
			durationMs: 1_500,
		};
		const entries: AgentEvalReportEntryData[] = [];
		createEvalsExtension(
			{
				append: async () => {},
				read: async () => [],
				saveBaseline: async () => {},
				readBaseline: async () => undefined,
			},
			undefined,
			undefined,
			undefined,
			undefined,
			{ append: async () => {}, read: async () => [base, latest] },
		)({
			registerCommand: (
				name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => commands.set(name, options.handler),
			registerTool: () => {},
			registerEntryRenderer: () => {},
			on: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			sendUserMessage: () => {},
			appendEntry: (type: string, data: AgentEvalReportEntryData | undefined) => {
				if (type === AGENT_EVAL_REPORT_ENTRY && data) entries.push(data);
			},
		} as unknown as ExtensionAPI);
		const command = commands.get("evals");
		if (!command) throw new Error("evals command was not registered");
		await command("latest", {
			hasUI: true,
			ui: { notify: () => {} },
		} as unknown as ExtensionCommandContext);
		expect(entries).toEqual([
			{
				version: 1,
				createdAt: expect.any(String),
				results: [latest],
				previousResults: [base],
			},
		]);
	});

	it("renders a compact report that Ctrl+O expands into the execution chain and metrics", () => {
		setLanguageSetting("zh-CN");
		const result: AgentEvalResult = {
			version: 1,
			id: "result-trace",
			caseId: "navigation-find-definition",
			title: "找到真实定义",
			category: "navigation",
			createdAt: "2026-08-09T00:00:00.000Z",
			provider: "test-provider",
			model: "test-model",
			thinkingLevel: "medium",
			passed: true,
			verificationPassed: true,
			budgetPassed: true,
			timedOut: false,
			durationMs: 2_000,
			totalTokens: 35_556,
			inputTokens: 35_000,
			outputTokens: 556,
			cacheReadTokens: 0,
			toolCalls: 1,
			toolErrors: 0,
			timing: { preparingMs: 10, startupMs: 300, agentMs: 1_400, verificationMs: 200, cleanupMs: 90 },
			trace: [
				{
					kind: "tool",
					name: "grep",
					startedAtMs: 500,
					durationMs: 120,
					status: "passed",
					input: "pattern=normalizeEndpoint · path=src",
					output: "src/internal/url-tools.mjs:12",
				},
			],
			assistantSummary: "Definition found in src/internal/url-tools.mjs.",
		};
		const data: AgentEvalReportEntryData = {
			version: 1,
			createdAt: "2026-08-09T00:00:02.000Z",
			results: [result],
			previousResults: [
				{
					...result,
					id: "result-before",
					createdAt: "2026-08-08T00:00:00.000Z",
					durationMs: 2_500,
					totalTokens: 36_000,
					outputTokens: 700,
					toolCalls: 2,
					trace: [
						{
							kind: "tool",
							name: "read",
							startedAtMs: 400,
							durationMs: 100,
							status: "passed",
						},
					],
				},
			],
		};
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const collapsed = createAgentEvalReportComponent(data, false, theme).render(100).join("\n");
		const expanded = createAgentEvalReportComponent(data, true, theme).render(100).join("\n");
		const firstRun = createAgentEvalReportComponent({ ...data, previousResults: [] }, true, theme)
			.render(100)
			.join("\n");
		expect(collapsed).toContain("Ctrl+O 展开详情");
		expect(collapsed).not.toContain("执行链路");
		expect(expanded).toContain("执行链路");
		expect(expanded).toContain("grep");
		expect(expanded).toContain("pattern=normalizeEndpoint");
		expect(expanded).toContain("与同一案例的上一次结果对比");
		expect(expanded).toContain("耗时：2.5s → 2.0s（-500ms）");
		expect(expanded).toContain("输出 token：700 → 556（-144）");
		expect(expanded).toContain("上次工具：2 次 · read×1");
		expect(expanded).toContain("本次工具：1 次 · read×0(-1) · grep×1(+1)");
		expect(expanded).toContain("启动 300ms");
		expect(expanded).toContain("输入 35k");
		expect(firstRun).toContain("这是该案例第一次运行，暂无历史结果");
	});
});
