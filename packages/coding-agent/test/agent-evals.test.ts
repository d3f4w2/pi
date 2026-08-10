import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_MEMORY_FILE } from "../src/config.ts";
import { AGENT_EVAL_CASES } from "../src/extensions/evals/agent-cases.ts";
import { IsolatedAgentEvalRunner } from "../src/extensions/evals/agent-runner.ts";
import { AgentEvalResultStore } from "../src/extensions/evals/agent-store.ts";
import type { JsonAgentSessionEvent } from "../src/modes/json-event.ts";

describe("Agent capability evaluation", () => {
	it("ships exactly one case for each initial capability", () => {
		expect(AGENT_EVAL_CASES).toHaveLength(6);
		expect(AGENT_EVAL_CASES.map((testCase) => testCase.category).sort()).toEqual([
			"bug_fix",
			"memory",
			"navigation",
			"recovery",
			"scope_control",
			"verification",
		]);
		expect(new Set(AGENT_EVAL_CASES.map((testCase) => testCase.id)).size).toBe(6);
		for (const testCase of AGENT_EVAL_CASES) {
			expect(Object.keys(testCase.publicFiles).some((file) => file.startsWith(".pi-eval-hidden/"))).toBe(false);
			expect(Object.keys(testCase.hiddenFiles).every((file) => file.startsWith(".pi-eval-hidden/"))).toBe(true);
		}
	});

	it("hides the verifier from the Agent and removes the temporary workspace", async () => {
		const testCase = AGENT_EVAL_CASES.find((candidate) => candidate.category === "navigation");
		if (!testCase) throw new Error("navigation case is missing");
		let workspace = "";
		let emit = (_event: JsonAgentSessionEvent): void => {};
		const runner = new IsolatedAgentEvalRunner((options) => {
			workspace = options.cwd ?? "";
			expect(options.env?.[ENV_MEMORY_FILE]).toBe(path.join(workspace, ".pi-eval-memory.json"));
			expect(options.args).toContain("--append-system-prompt");
			expect(options.args?.find((argument) => argument.includes("Prefer the dedicated grep tool."))).toContain(
				"Prefer the dedicated grep tool.",
			);
			return {
				start: async () => {},
				onEvent: (listener) => {
					emit = listener;
					return () => {};
				},
				promptAndWait: async () => {
					expect(existsSync(path.join(workspace, ".pi-eval-hidden"))).toBe(false);
					emit({
						type: "tool_execution_start",
						toolCallId: "grep-1",
						toolName: "grep",
						args: { pattern: "normalizeEndpoint", path: "src" },
					});
					await writeFile(
						path.join(workspace, "answer.json"),
						'{"file":"src/internal/url-tools.mjs","symbol":"normalizeEndpoint"}\n',
						"utf8",
					);
					emit({
						type: "tool_execution_end",
						toolCallId: "grep-1",
						toolName: "grep",
						result: { content: [{ type: "text", text: "src/internal/url-tools.mjs:12" }] },
						isError: false,
					});
					return [];
				},
				getSessionStats: async () => ({
					sessionFile: undefined,
					sessionId: "eval-session",
					userMessages: 1,
					assistantMessages: 1,
					toolCalls: 2,
					toolResults: 2,
					totalMessages: 4,
					tokens: { input: 35_000, output: 556, cacheRead: 0, cacheWrite: 0, total: 35_556 },
					cost: 0,
				}),
				abort: async () => {},
				stop: async () => {},
			};
		});
		const result = await runner.run(testCase, {
			provider: "test-provider",
			model: "test-model",
			thinkingLevel: "medium",
			tools: ["read", "grep", "write"],
			appendSystemPrompt: "Prefer the dedicated grep tool.",
		});
		expect(result).toMatchObject({
			passed: true,
			verificationPassed: true,
			budgetPassed: true,
			totalTokens: 35_556,
			outputTokens: 556,
			toolCalls: 2,
		});
		expect(result.timing).toMatchObject({
			preparingMs: expect.any(Number),
			startupMs: expect.any(Number),
			agentMs: expect.any(Number),
			verificationMs: expect.any(Number),
			cleanupMs: expect.any(Number),
		});
		expect(result.trace).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "tool",
					name: "grep",
					status: "passed",
					input: "path=src · pattern=normalizeEndpoint",
					output: "src/internal/url-tools.mjs:12",
				}),
			]),
		);
		expect(existsSync(workspace)).toBe(false);
	});

	it("requires the memory case to use the real memory tool", async () => {
		const testCase = AGENT_EVAL_CASES.find((candidate) => candidate.category === "memory");
		if (!testCase) throw new Error("memory case is missing");
		let workspace = "";
		const runner = new IsolatedAgentEvalRunner((options) => {
			workspace = options.cwd ?? "";
			return {
				start: async () => {},
				onEvent: () => () => {},
				promptAndWait: async () => {
					await writeFile(
						path.join(workspace, ".pi-eval-memory.json"),
						JSON.stringify({
							records: [
								{
									kind: "user",
									status: "active",
									claim: { value: "concise" },
									content: "Keep replies concise.",
								},
							],
						}),
						"utf8",
					);
					return [];
				},
				getSessionStats: async () => ({
					sessionFile: undefined,
					sessionId: "memory-eval",
					userMessages: 1,
					assistantMessages: 1,
					toolCalls: 0,
					toolResults: 0,
					totalMessages: 2,
					tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
					cost: 0,
				}),
				abort: async () => {},
				stop: async () => {},
			};
		});
		const result = await runner.run(testCase, {
			provider: "test-provider",
			model: "test-model",
			thinkingLevel: "medium",
			tools: [],
		});
		expect(result).toMatchObject({
			passed: false,
			verificationPassed: true,
			failure: "Required tool was not used: memory",
		});
	});

	it("marks a bounded child timeout as a failed capability result", async () => {
		const testCase = AGENT_EVAL_CASES[0];
		if (!testCase) throw new Error("Agent evaluation cases are missing");
		let aborted = false;
		const runner = new IsolatedAgentEvalRunner(() => ({
			start: async () => {},
			onEvent: () => () => {},
			promptAndWait: async () => {
				throw new Error("Timeout collecting events");
			},
			getSessionStats: async () => ({
				sessionFile: undefined,
				sessionId: "timed-out",
				userMessages: 1,
				assistantMessages: 0,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: 2,
				tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, total: 20 },
				cost: 0,
			}),
			abort: async () => {
				aborted = true;
			},
			stop: async () => {},
		}));
		const result = await runner.run(testCase, {
			provider: "test-provider",
			model: "test-model",
			thinkingLevel: "medium",
			tools: ["read"],
		});
		expect(result).toMatchObject({ passed: false, timedOut: true });
		expect(aborted).toBe(true);
	});

	it("persists compact Agent results separately from evaluator self-check reports", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-agent-eval-store-"));
		try {
			const store = new AgentEvalResultStore(directory);
			const result = {
				version: 1 as const,
				id: "result-1",
				caseId: "navigation-find-definition",
				title: "找到真实定义",
				category: "navigation" as const,
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
				timing: { preparingMs: 10, startupMs: 20, agentMs: 800, verificationMs: 100, cleanupMs: 70 },
				trace: [
					{
						kind: "tool" as const,
						name: "read",
						startedAtMs: 30,
						durationMs: 40,
						status: "passed" as const,
						input: "path=src/index.ts",
						output: "export function main",
					},
				],
				assistantSummary: "Found the definition.",
			};
			await store.append(result);
			expect(await store.read()).toEqual([result]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
