import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRunReceiptEnvelope,
	hashPrivateText,
	type RunReceipt,
	verifyRunReceiptText,
	writeRunReceipt,
} from "../src/cli/run-receipt.ts";

const temporaryDirectories: string[] = [];

function receipt(): RunReceipt {
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

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("verifiable run receipt", () => {
	it("creates and verifies a deterministic canonical integrity digest", () => {
		const first = createRunReceiptEnvelope(receipt());
		const second = createRunReceiptEnvelope(receipt());

		expect(first.integrity).toEqual({
			algorithm: "sha256",
			canonicalization: "json-sorted-keys-v1",
			digest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(first.integrity.digest).toBe(second.integrity.digest);
		expect(verifyRunReceiptText(JSON.stringify(first))).toEqual(first);
	});

	it("rejects changed or malformed receipt content", () => {
		const envelope = createRunReceiptEnvelope(receipt());
		const changed = JSON.stringify({ ...envelope, receipt: { ...envelope.receipt, durationMs: 9999 } });
		const incompleteReceipt = receipt();
		Reflect.deleteProperty(incompleteReceipt, "contract");
		const incomplete = createRunReceiptEnvelope(incompleteReceipt);

		expect(() => verifyRunReceiptText(changed)).toThrow(/完整性/);
		expect(() => verifyRunReceiptText("{}")).toThrow(/回执/);
		expect(() => verifyRunReceiptText(JSON.stringify(incomplete))).toThrow(/contract/);
	});

	it("rejects non-canonical workspace paths and fractional counters", () => {
		const unsafePath = receipt();
		unsafePath.workspace.changed[0]!.path = "src/../secret.txt";
		const fractionalUsage = receipt();
		fractionalUsage.execution.usage.totalTokens = 1.5;

		expect(() => verifyRunReceiptText(JSON.stringify(createRunReceiptEnvelope(unsafePath)))).toThrow(/相对路径/);
		expect(() => verifyRunReceiptText(JSON.stringify(createRunReceiptEnvelope(fractionalUsage)))).toThrow(/安全整数/);
	});

	it("stores only hashes for private task and response text", () => {
		const privateTask = "fix secret customer parser";
		const privateResponse = "changed secret source successfully";
		const value = receipt();
		value.contract.task = hashPrivateText(privateTask);
		value.execution.finalResponse = {
			sha256: hashPrivateText(privateResponse).sha256,
			characters: privateResponse.length,
		};
		const serialized = JSON.stringify(createRunReceiptEnvelope(value));

		expect(serialized).not.toContain(privateTask);
		expect(serialized).not.toContain(privateResponse);
		expect(value.contract.task.utf8Bytes).toBe(Buffer.byteLength(privateTask));
	});

	it("makes identical receipt writes idempotent but refuses different content", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pigo-run-receipt-"));
		temporaryDirectories.push(directory);
		const receiptPath = path.join(directory, "nested", "run.json");
		const envelope = createRunReceiptEnvelope(receipt());

		await writeRunReceipt(receiptPath, envelope);
		expect(verifyRunReceiptText(await readFile(receiptPath, "utf8"))).toEqual(envelope);
		await expect(writeRunReceipt(receiptPath, envelope)).resolves.toBeUndefined();
		const different = receipt();
		different.finishedAt = "2026-08-12T10:00:02.250Z";
		await expect(writeRunReceipt(receiptPath, createRunReceiptEnvelope(different))).rejects.toThrow(/已存在/);
	});
});
