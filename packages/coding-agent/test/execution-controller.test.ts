import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import executionControllerExtension from "../src/extensions/execution-controller/index.ts";
import {
	ExecutionPolicy,
	mutationPaths,
	needsCodeVerification,
	type ObservedToolResult,
	verificationOutcome,
} from "../src/extensions/execution-controller/policy.ts";

function result(
	toolName: string,
	input: Record<string, unknown>,
	details: unknown = undefined,
	isError = false,
): ObservedToolResult {
	return { toolName, input, details, isError };
}

describe("execution controller policy", () => {
	it("tracks supported code and build configuration paths only", () => {
		expect(needsCodeVerification("src/user.ts")).toBe(true);
		expect(needsCodeVerification("C:\\repo\\service.py")).toBe(true);
		expect(needsCodeVerification("go.mod")).toBe(true);
		expect(needsCodeVerification("docs/design.md")).toBe(false);
		expect(needsCodeVerification("assets/logo.png")).toBe(false);
	});

	it("extracts successful mutations without guessing failed or unrelated writes", () => {
		expect(mutationPaths(result("edit", { path: "src/user.ts" }))).toEqual(["src/user.ts"]);
		expect(
			mutationPaths(result("ast_edit", { path: "src" }, { changedFiles: ["src/a.ts", "src/b.ts", "README.md"] })),
		).toEqual(["src/a.ts", "src/b.ts"]);
		expect(mutationPaths(result("write", { path: "README.md" }))).toEqual([]);
		expect(mutationPaths(result("write", { path: "src/user.ts" }, undefined, true))).toEqual([]);
	});

	it("requires current-revision evidence and invalidates stale verification", () => {
		const policy = new ExecutionPolicy();
		policy.recordToolResult(result("edit", { path: "src/user.ts" }));
		expect(policy.takeReminder()).toBe("missing");
		expect(policy.takeReminder()).toBeUndefined();

		policy.recordToolResult(result("verify", {}, { passed: true, checks: [] }));
		expect(policy.takeReminder()).toBeUndefined();

		policy.recordToolResult(result("edit", { path: "src/user.ts" }));
		expect(policy.takeReminder()).toBe("missing");
		expect(policy.snapshot()).toMatchObject({ revision: 2, verifiedRevision: 1, reminderCount: 2 });
	});

	it("distinguishes failed checks from unavailable optional tooling", () => {
		expect(verificationOutcome(result("verify", {}, { passed: false, checks: [{ status: "failed" }] }))).toBe(
			"failed",
		);
		expect(
			verificationOutcome(
				result("verify", {}, { passed: false, checks: [{ status: "unavailable" }, { status: "timed_out" }] }),
			),
		).toBe("waived");
		expect(verificationOutcome(result("lsp", { operation: "diagnostics" }, { resultCount: 0 }))).toBe("passed");
	});

	it("allows one new reminder after a failed verification and then fails open", () => {
		const policy = new ExecutionPolicy();
		policy.recordToolResult(result("write", { path: "main.go" }));
		expect(policy.takeReminder()).toBe("missing");
		policy.recordToolResult(result("verify", {}, { passed: false, checks: [{ status: "failed" }] }));
		expect(policy.takeReminder()).toBe("failed");
		policy.recordToolResult(result("edit", { path: "main.go" }));
		expect(policy.takeReminder()).toBeUndefined();
	});

	it("waives further reminders when verification cannot run", () => {
		const policy = new ExecutionPolicy();
		policy.recordToolResult(result("write", { path: "main.py" }));
		policy.recordToolResult(
			result("verify", {}, { passed: false, checks: [{ status: "unavailable" }, { status: "timed_out" }] }),
		);
		expect(policy.takeReminder()).toBeUndefined();
		expect(policy.snapshot()).toMatchObject({ revision: 1, waivedRevision: 1 });
	});
});

describe("execution controller extension", () => {
	it("steers only when a code change is about to finish without verification", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const sent: Array<{ message: { customType: string; content: unknown }; options: unknown }> = [];
		let activeTools = ["read", "edit", "verify"];
		const api = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
			getActiveTools: () => activeTools,
			sendMessage: (message: { customType: string; content: unknown }, options: unknown) =>
				sent.push({ message, options }),
		} as unknown as ExtensionAPI;
		const context = { hasPendingMessages: () => false } as unknown as ExtensionContext;
		executionControllerExtension(api);

		await handlers.get("agent_start")?.({ type: "agent_start" }, context);
		await handlers.get("tool_result")?.(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "edit-1",
				input: { path: "src/user.ts" },
				content: [],
				details: undefined,
				isError: false,
			},
			context,
		);
		await handlers.get("turn_end")?.(
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", stopReason: "stop", content: [] },
				toolResults: [],
			},
			context,
		);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			message: { customType: "single-agent-controller", content: expect.stringContaining("verify") },
			options: { deliverAs: "steer" },
		});

		activeTools = ["read", "edit"];
		await handlers.get("agent_start")?.({ type: "agent_start" }, context);
		await handlers.get("tool_result")?.(
			{
				type: "tool_result",
				toolName: "write",
				toolCallId: "write-1",
				input: { path: "main.py" },
				content: [],
				details: undefined,
				isError: false,
			},
			context,
		);
		await handlers.get("turn_end")?.(
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", stopReason: "stop", content: [] },
				toolResults: [],
			},
			context,
		);
		expect(sent).toHaveLength(1);
	});
});
