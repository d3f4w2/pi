import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { PromptCacheOptimizationDiagnostic } from "../src/core/prompt-cache-optimizer.ts";
import { PromptCacheRuntime } from "../src/core/prompt-cache-runtime.ts";

const diagnostic: PromptCacheOptimizationDiagnostic = {
	reason: "optimized",
	promptCacheKey: "private-key",
	stableShapeSha256: "a".repeat(64),
	projectScopeSha256: "b".repeat(64),
	modelSha256: "c".repeat(64),
	stableSystemPromptSha256: "d".repeat(64),
	fullSystemPromptSha256: "d".repeat(64),
	toolOrderSha256: "e".repeat(64),
	toolSetSha256: "e".repeat(64),
	outputShapeSha256: "f".repeat(64),
	explicitBreakpoint: "applied",
	breakpointsApplied: 2,
	breakpointCandidates: 1,
	breakpointDecision: "positive-roi",
};

const model: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 128_000,
	maxTokens: 4_096,
};

function response(cacheRead: number, input: number, cacheWrite = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input,
			output: 10,
			cacheRead,
			cacheWrite,
			totalTokens: input + cacheRead + cacheWrite + 10,
			cost: {
				input: input / 1_000_000,
				output: 0.00002,
				cacheRead: (cacheRead * 0.1) / 1_000_000,
				cacheWrite: (cacheWrite * 1.25) / 1_000_000,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: 2_000,
	};
}

describe("PromptCacheRuntime", () => {
	it("joins exact-prefix evidence with provider-reported usage", () => {
		const runtime = new PromptCacheRuntime(() => model);
		const firstPayload = {
			input: [
				{ role: "developer", content: "stable" },
				{ role: "user", content: [{ type: "input_text", text: "one" }] },
			],
		};
		const secondPayload = {
			input: [
				...firstPayload.input,
				{ role: "assistant", content: [{ type: "output_text", text: "answer" }] },
				{ role: "user", content: [{ type: "input_text", text: "two" }] },
			],
		};

		runtime.recordRequest(diagnostic, firstPayload, 1_000);
		runtime.recordResponse(response(0, 10_000));
		runtime.recordRequest(diagnostic, secondPayload, 2_000);
		runtime.recordResponse(response(8_000, 2_000));

		const report = runtime.snapshot();
		expect(report.requests).toBe(2);
		expect(report.responses).toBe(2);
		expect(report.actualCacheReadRate).toBeCloseTo(0.4);
		expect(report.firstResponseCacheReadRate).toBe(0);
		expect(report.subsequentResponseCacheReadRate).toBeCloseTo(0.8);
		expect(report.lastResponseCacheReadRate).toBeCloseTo(0.8);
		expect(report.exactPrefixBytes).toBeGreaterThan(0);
		expect(report.exactPrefixByteRate).toBeGreaterThan(0);
		expect(report.estimatedSavingsUsd).toBeGreaterThan(0);
		expect(report.breakpointDecisions["positive-roi"]).toBe(2);
	});

	it("records provider retry recovery and failure diagnostics without error text", () => {
		const runtime = new PromptCacheRuntime(() => model);
		const recovered = response(8_000, 2_000);
		recovered.diagnostics = [
			{
				type: "provider_request_retry",
				timestamp: 1_000,
				details: { attempts: 1, status: "success" },
			},
		];
		const failed = response(0, 0);
		failed.stopReason = "error";
		failed.errorMessage = "private gateway detail";
		failed.diagnostics = [
			{
				type: "provider_request_retry",
				timestamp: 2_000,
				details: { attempts: 2, status: "failed" },
			},
		];

		runtime.recordResponse(recovered);
		runtime.recordResponse(failed);

		const report = runtime.snapshot();
		expect(report.providerRetryAttempts).toBe(3);
		expect(report.providerRetryRecoveries).toBe(1);
		expect(report.providerRetryFailures).toBe(1);
		expect(JSON.stringify(report)).not.toContain("private gateway detail");
	});

	it("records drift causes and never exposes payload text", () => {
		const runtime = new PromptCacheRuntime(() => model);
		runtime.recordRequest(diagnostic, { input: [{ role: "user", content: "private-one" }] }, 1_000);
		runtime.recordRequest(
			{ ...diagnostic, fullSystemPromptSha256: "1".repeat(64) },
			{ input: [{ role: "user", content: "private-two" }] },
			2_000,
		);

		const serialized = JSON.stringify(runtime.snapshot());
		const internalState = JSON.stringify(runtime);
		expect(runtime.snapshot().changeCounts["dynamic-system-suffix"]).toBe(1);
		expect(serialized).not.toContain("private-one");
		expect(serialized).not.toContain("private-two");
		expect(serialized).not.toContain("private-key");
		expect(internalState).not.toContain("private-one");
		expect(internalState).not.toContain("private-two");
	});

	it("tracks compaction deferrals in the same session report", () => {
		const runtime = new PromptCacheRuntime(() => model);
		runtime.recordCompactionDeferral();
		expect(runtime.snapshot().compactionDeferrals).toBe(1);
	});
});
