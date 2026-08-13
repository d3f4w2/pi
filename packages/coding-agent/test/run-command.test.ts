import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type AgentExecutionResult, type RunCommandDependencies, runRunCommand } from "../src/cli/run-command.ts";
import { createRunReceiptEnvelope, type RunReceiptEnvelope } from "../src/cli/run-receipt.ts";
import type { WorkspaceSnapshot } from "../src/cli/run-workspace.ts";
import type { VerifyResult } from "../src/extensions/verify/types.ts";

function snapshot(
	digest: string,
	dirty: ReadonlyMap<string, string>,
	index: ReadonlyMap<string, string> = new Map([["src/parser.ts", "100644:abc"]]),
): WorkspaceSnapshot {
	return {
		root: "/repo",
		head: "1".repeat(40),
		digest: createHash("sha256").update(digest).digest("hex"),
		coverage: "git-tracked-and-unignored",
		index,
		dirty,
	};
}

function execution(overrides: Partial<AgentExecutionResult> = {}): AgentExecutionResult {
	return {
		exitCode: 0,
		terminationReason: "completed",
		stderr: "",
		summary: {
			turns: 1,
			toolCalls: { edit: 1 },
			toolErrors: 0,
			usage: {
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 80,
				cacheWriteTokens: 0,
				totalTokens: 200,
				cost: 0.02,
			},
			model: { provider: "openai", id: "gpt-5.6" },
			finalResponse: "private final response",
			protocolErrors: 0,
			agentEnded: true,
			agentFailed: false,
		},
		...overrides,
	};
}

function verifyResult(status: "passed" | "failed" | "unavailable" = "passed"): VerifyResult {
	return {
		text: status,
		details: {
			operation: "auto",
			language: "typescript",
			workspaceRoot: "/repo",
			passed: status === "passed",
			checks: [{ id: "typecheck", label: "TypeScript", status, durationMs: 50, command: "npm run check" }],
			truncated: false,
			durationMs: 50,
		},
	};
}

function harness(
	options: {
		before?: WorkspaceSnapshot;
		after?: WorkspaceSnapshot;
		execution?: AgentExecutionResult;
		verify?: VerifyResult;
		readText?: string;
		monotonicTimes?: number[];
	} = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	const receipts: RunReceiptEnvelope[] = [];
	const snapshots = [
		options.before ?? snapshot("before", new Map()),
		options.after ?? snapshot("after", new Map([["src/parser.ts", "dirty:index=100644:abc:worktree=file:def:x0"]])),
	];
	const verify = vi.fn(async () => options.verify ?? verifyResult());
	const defaultReceiptPath = vi.fn(() => "/receipts/run.json");
	let time = 0;
	const monotonicTimes = [...(options.monotonicTimes ?? [0])];
	let lastMonotonicTime = monotonicTimes[0] ?? 0;
	const dependencies: RunCommandDependencies = {
		cwd: () => "/repo",
		now: () => new Date(time++ === 0 ? "2026-08-12T10:00:00.000Z" : "2026-08-12T10:00:01.000Z"),
		monotonicNow: () => {
			lastMonotonicTime = monotonicTimes.shift() ?? lastMonotonicTime;
			return lastMonotonicTime;
		},
		randomUUID: () => "01915f45-8ea3-7000-8000-000000000001",
		readTextFile: async () => options.readText ?? "",
		getWorkspaceRoot: async () => "/repo",
		takeSnapshot: async () => {
			const next = snapshots.shift();
			if (!next) throw new Error("unexpected snapshot");
			return next;
		},
		executeAgent: async () => options.execution ?? execution(),
		verify,
		defaultReceiptPath,
		assertReceiptTargetAvailable: async () => {},
		writeReceipt: async (_receiptPath, envelope) => {
			receipts.push(envelope);
		},
		writeStdout: (value) => stdout.push(value),
		writeStderr: (value) => stderr.push(value),
		setExitCode: (value) => exitCodes.push(value),
	};
	return { dependencies, stdout, stderr, exitCodes, receipts, verify, defaultReceiptPath };
}

describe("pigo run command", () => {
	it("returns verified only after independent checks pass", async () => {
		const test = harness();

		const exitCode = await runRunCommand(["private task text"], test.dependencies);

		expect(exitCode).toBe(0);
		expect(test.exitCodes).toEqual([0]);
		expect(test.verify).toHaveBeenCalledOnce();
		expect(test.receipts[0]?.receipt.result.outcome).toBe("verified");
		expect(JSON.stringify(test.receipts[0])).not.toContain("private task text");
		expect(JSON.stringify(test.receipts[0])).not.toContain("private final response");
		expect(test.stdout.join("")).toContain("private final response");
		expect(test.stderr.join("")).toContain("verified");
		expect(test.defaultReceiptPath).toHaveBeenCalledWith("01915f45-8ea3-7000-8000-000000000001", "/repo");
	});

	it("skips verification and returns completed when the workspace did not change", async () => {
		const clean = snapshot("same", new Map());
		const test = harness({ before: clean, after: clean });

		const exitCode = await runRunCommand(["answer a question"], test.dependencies);

		expect(exitCode).toBe(0);
		expect(test.verify).not.toHaveBeenCalled();
		expect(test.receipts[0]?.receipt.result.outcome).toBe("completed");
	});

	it("gives scope and budget violations precedence over successful checks", async () => {
		const test = harness();

		const exitCode = await runRunCommand(["task", "--scope", "test"], test.dependencies);

		expect(exitCode).toBe(3);
		expect(test.receipts[0]?.receipt.result.outcome).toBe("noncompliant");
		expect(test.receipts[0]?.receipt.workspace.scopeViolations).toEqual(["src/parser.ts"]);
	});

	it("applies the wall-clock budget to post-execution verification", async () => {
		const test = harness({ monotonicTimes: [0, 1000] });

		const exitCode = await runRunCommand(["task", "--timeout", "1"], test.dependencies);

		expect(exitCode).toBe(3);
		expect(test.verify).not.toHaveBeenCalled();
		expect(test.receipts[0]?.receipt.execution.terminationReason).toBe("timeout");
		expect(test.receipts[0]?.receipt.result.outcome).toBe("noncompliant");
	});

	it("rejects a verification result that arrives after the wall-clock deadline", async () => {
		const test = harness({ monotonicTimes: [0, 100, 100, 1000] });

		const exitCode = await runRunCommand(["task", "--timeout", "1"], test.dependencies);

		expect(exitCode).toBe(3);
		expect(test.verify).toHaveBeenCalledOnce();
		expect(test.receipts[0]?.receipt.verification).toHaveLength(1);
		expect(test.receipts[0]?.receipt.execution.terminationReason).toBe("timeout");
		expect(test.receipts[0]?.receipt.result.outcome).toBe("noncompliant");
	});

	it.each([
		["failed", 1, "failed"],
		["unavailable", 2, "unverified"],
	] as const)("maps a %s independent check to a stable outcome", async (status, expectedExit, outcome) => {
		const test = harness({ verify: verifyResult(status) });

		const exitCode = await runRunCommand(["task"], test.dependencies);

		expect(exitCode).toBe(expectedExit);
		expect(test.receipts[0]?.receipt.result.outcome).toBe(outcome);
	});

	it("emits only the receipt envelope on stdout in JSON mode", async () => {
		const test = harness();

		await runRunCommand(["task", "--json"], test.dependencies);

		const value = JSON.parse(test.stdout.join("")) as RunReceiptEnvelope;
		expect(value.receipt.result.outcome).toBe("verified");
		expect(test.stdout.join("")).not.toContain("private final response");
	});

	it("verifies an existing receipt without starting an agent or requiring Git", async () => {
		const source = harness();
		await runRunCommand(["task"], source.dependencies);
		const envelope = source.receipts[0];
		if (!envelope) throw new Error("missing fixture receipt");
		const test = harness({ readText: JSON.stringify(createRunReceiptEnvelope(envelope.receipt)) });
		const executeAgent = vi.fn(test.dependencies.executeAgent);
		const getWorkspaceRoot = vi.fn(test.dependencies.getWorkspaceRoot);

		const exitCode = await runRunCommand(["--check-receipt", "run.json", "--json"], {
			...test.dependencies,
			executeAgent,
			getWorkspaceRoot,
		});

		expect(exitCode).toBe(0);
		expect(executeAgent).not.toHaveBeenCalled();
		expect(getWorkspaceRoot).not.toHaveBeenCalled();
		expect(JSON.parse(test.stdout.join("")).valid).toBe(true);
	});
});
