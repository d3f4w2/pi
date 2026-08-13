import { describe, expect, it } from "vitest";
import {
	createDefaultCiPolicy,
	evaluateCiGate,
	evaluateCiReceipt,
	hashCiPolicy,
	parseCiPolicyText,
} from "../src/cli/ci-policy.ts";
import { createRunReceiptEnvelope } from "../src/cli/run-receipt.ts";
import { createTestRunReceipt, createTestRunReceiptEnvelope } from "./fixtures/run-receipt.ts";

describe("receipt-native CI policy", () => {
	it("uses a strict deterministic default policy", () => {
		const policy = createDefaultCiPolicy();

		expect(evaluateCiReceipt(createTestRunReceiptEnvelope(), policy)).toEqual([]);
		expect(policy.allowedOutcomes).toEqual(["verified", "completed"]);
		expect(policy.perRunLimits).toEqual({ toolErrors: 0, protocolErrors: 0 });
		expect(hashCiPolicy(policy)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("parses strict policy overrides and rejects unknown fields", () => {
		const policy = parseCiPolicyText(
			JSON.stringify({
				version: 1,
				allowedOutcomes: ["verified"],
				requirements: { requiredChecks: ["typecheck"], allowedScopes: ["src\\parser", "test"] },
				perRunLimits: { totalTokens: 200, costUsd: 0.03 },
				aggregateLimits: { totalTokens: 500 },
			}),
		);

		expect(policy.requirements.allowedScopes).toEqual(["src/parser", "test"]);
		expect(policy.requirements.headUnchanged).toBe(true);
		expect(policy.perRunLimits).toMatchObject({ totalTokens: 200, costUsd: 0.03, toolErrors: 0 });
		expect(() => parseCiPolicyText('{"version":1,"unknown":true}')).toThrow(/unknown field/);
		expect(() => parseCiPolicyText('{"version":1,"requirements":{"allowedScopes":["../outside"]}}')).toThrow(
			/workspace/,
		);
	});

	it("reports independent governance violations with stable codes", () => {
		const receipt = createTestRunReceipt();
		receipt.result.outcome = "unverified";
		receipt.workspace.headChanged = true;
		receipt.workspace.scopeViolations = ["secrets.txt"];
		receipt.contract.scope = ["."];
		receipt.verification[0]!.passed = false;
		receipt.verification[0]!.checks[0]!.status = "failed";
		receipt.execution.toolErrors = 1;
		const policy = parseCiPolicyText(
			JSON.stringify({
				version: 1,
				requirements: { requiredChecks: ["test"], allowedScopes: ["src", "test"] },
				perRunLimits: { durationMs: 1000, totalTokens: 100, costUsd: 0.01, toolCalls: 2 },
			}),
		);

		const codes = evaluateCiReceipt(createRunReceiptEnvelope(receipt), policy).map(({ code }) => code);

		expect(codes).toEqual(
			expect.arrayContaining([
				"outcome.disallowed",
				"workspace.head_changed",
				"workspace.scope_violation",
				"verification.missing_or_failed",
				"verification.check_failed",
				"verification.required_check_missing",
				"contract.scope_disallowed",
				"limit.duration",
				"limit.tokens",
				"limit.cost",
				"limit.tool_calls",
				"limit.tool_errors",
			]),
		);
	});

	it("fails closed on internally inconsistent evidence and contract budget breaches", () => {
		const receipt = createTestRunReceipt();
		receipt.result.outcome = "completed";
		receipt.workspace.headAfter = "2".repeat(40);
		receipt.contract.budget.maxTokens = 100;
		receipt.contract.budget.maxToolCalls = 2;

		const codes = evaluateCiReceipt(createRunReceiptEnvelope(receipt), createDefaultCiPolicy()).map(
			({ code }) => code,
		);

		expect(codes).toEqual(
			expect.arrayContaining([
				"receipt.outcome_inconsistent",
				"receipt.head_inconsistent",
				"contract.token_budget_exceeded",
				"contract.tool_budget_exceeded",
			]),
		);
	});

	it("derives truthful failed outcomes for interactive iteration exhaustion and user stop", () => {
		const exhausted = createTestRunReceipt();
		exhausted.execution.exitCode = 1;
		exhausted.execution.terminationReason = "iteration_budget";
		exhausted.result.outcome = "noncompliant";
		const exhaustedCodes = evaluateCiReceipt(createRunReceiptEnvelope(exhausted), createDefaultCiPolicy()).map(
			({ code }) => code,
		);
		expect(exhaustedCodes).toContain("outcome.disallowed");
		expect(exhaustedCodes).not.toContain("receipt.outcome_inconsistent");

		const stopped = createTestRunReceipt();
		stopped.execution.exitCode = 1;
		stopped.execution.terminationReason = "user_stopped";
		stopped.result.outcome = "failed";
		const stoppedCodes = evaluateCiReceipt(createRunReceiptEnvelope(stopped), createDefaultCiPolicy()).map(
			({ code }) => code,
		);
		expect(stoppedCodes).toContain("outcome.disallowed");
		expect(stoppedCodes).not.toContain("receipt.outcome_inconsistent");
	});

	it("evaluates invalid receipts and aggregate limits in one batch report", () => {
		const policy = parseCiPolicyText('{"version":1,"aggregateLimits":{"totalTokens":100}}');
		const report = evaluateCiGate(
			[
				{ file: "a.json", envelope: createTestRunReceiptEnvelope() },
				{ file: "broken.json", error: "integrity mismatch" },
			],
			policy,
			"pigo.ci.json",
		);

		expect(report.passed).toBe(false);
		expect(report.summary).toEqual({ receipts: 2, valid: 1, passed: 1, failed: 1 });
		expect(report.receipts[1]?.violations[0]?.code).toBe("receipt.invalid");
		expect(report.violations[0]?.code).toBe("aggregate.tokens");
		expect(report.aggregate.totalTokens).toBe(150);
	});
});
