import { createRunReceiptEnvelope, type RunReceipt, type RunReceiptEnvelope } from "../../src/cli/run-receipt.ts";

export function createTestRunReceipt(): RunReceipt {
	return {
		schemaVersion: 1,
		runId: "01915f45-8ea3-7000-8000-000000000001",
		startedAt: "2026-08-12T10:00:00.000Z",
		finishedAt: "2026-08-12T10:00:01.250Z",
		durationMs: 1250,
		contract: {
			sha256: "a".repeat(64),
			task: { sha256: "b".repeat(64), utf8Bytes: 18 },
			scope: ["src", "test"],
			verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
			budget: { timeoutSeconds: 900, maxTokens: 50_000, maxToolCalls: 100 },
		},
		workspace: {
			coverage: "git-tracked-and-unignored",
			headBefore: "1".repeat(40),
			headAfter: "1".repeat(40),
			headChanged: false,
			beforeDigest: "c".repeat(64),
			afterDigest: "d".repeat(64),
			changed: [
				{
					path: "src/parser.ts",
					before: "clean:index=100644:abc",
					after: "dirty:index=100644:abc:worktree=file:def:x0",
				},
			],
			scopeViolations: [],
		},
		execution: {
			exitCode: 0,
			terminationReason: "completed",
			turns: 2,
			toolCalls: { edit: 1, read: 2 },
			toolErrors: 0,
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 80,
				cacheWriteTokens: 0,
				totalTokens: 150,
				cost: 0.02,
			},
			finalResponse: { sha256: "e".repeat(64), characters: 42 },
			protocolErrors: 0,
		},
		verification: [
			{
				operation: "auto",
				path: ".",
				passed: true,
				durationMs: 500,
				checks: [{ id: "typecheck", status: "passed", durationMs: 500, command: "npm run check" }],
			},
		],
		result: { outcome: "verified" },
	};
}

export function createTestRunReceiptEnvelope(): RunReceiptEnvelope {
	return createRunReceiptEnvelope(createTestRunReceipt());
}
