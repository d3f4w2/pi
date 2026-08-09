import type { ToolApproval } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { ToolApprovalMode, ToolApprovalSetting } from "../src/core/settings-manager.ts";
import { evaluateToolApproval, type ToolApprovalSource } from "../src/core/tool-approval.ts";

function tool(name: string, approval?: ToolApproval): ToolApprovalSource {
	return { name, approval };
}

function evaluate(
	source: ToolApprovalSource,
	args: unknown = {},
	options: {
		mode?: ToolApprovalMode;
		policies?: Record<string, ToolApprovalSetting>;
		canPrompt?: boolean;
		approved?: ReadonlySet<string>;
	} = {},
) {
	return evaluateToolApproval({
		tool: source,
		args,
		cwd: "C:\\repo",
		settings: { mode: options.mode ?? "yolo", policies: options.policies ?? {} },
		canPrompt: options.canPrompt ?? true,
		approvedFingerprints: options.approved,
	});
}

describe("tool approval policy", () => {
	it("keeps ordinary work uninterrupted in yolo mode", () => {
		expect(evaluate(tool("read")).action).toBe("allow");
		expect(evaluate(tool("write"), { path: "src/index.ts" }).action).toBe("allow");
		expect(evaluate(tool("bash"), { command: "npm run check" }).action).toBe("allow");
	});

	it("uses read, write, and exec tiers in stricter modes", () => {
		expect(evaluate(tool("read"), {}, { mode: "always-ask" }).action).toBe("prompt");
		expect(evaluate(tool("edit"), {}, { mode: "always-ask" }).action).toBe("prompt");
		expect(evaluate(tool("read"), {}, { mode: "write" }).action).toBe("allow");
		expect(evaluate(tool("edit"), {}, { mode: "write" }).action).toBe("prompt");
		expect(evaluate(tool("bash"), {}, { mode: "write" }).action).toBe("prompt");
		expect(evaluate(tool("lsp"), { operation: "references" }, { mode: "always-ask" }).action).toBe("prompt");
		expect(evaluate(tool("lsp"), { operation: "rename" }, { mode: "always-ask" }).action).toBe("prompt");
		expect(evaluate(tool("unknown_extension"), {}, { mode: "write" }).tier).toBe("exec");
	});

	it("honors explicit deny and prompt policies", () => {
		expect(evaluate(tool("read"), {}, { policies: { read: "deny" } }).action).toBe("deny");
		expect(evaluate(tool("read"), {}, { policies: { read: "prompt" } }).action).toBe("prompt");
		expect(evaluate(tool("custom", { tier: "exec", policy: "deny", reason: "blocked" })).action).toBe("deny");
	});

	it("always prompts for clearly destructive shell commands", () => {
		const result = evaluate(tool("bash"), { command: "git reset --hard HEAD~1" }, { policies: { bash: "allow" } });
		expect(result.action).toBe("prompt");
		expect(result.reason).toContain("危险命令");
	});

	it("always prompts before writing outside the workspace", () => {
		const result = evaluate(tool("write"), { path: "C:\\Users\\person\\Desktop\\outside.txt" });
		expect(result.action).toBe("prompt");
		expect(result.reason).toContain("工作区外");
	});

	it("fails closed when a required prompt has no interactive UI", () => {
		const result = evaluate(tool("bash"), { command: "git reset --hard" }, { canPrompt: false });
		expect(result.action).toBe("deny");
		expect(result.reason).toContain("没有可用的确认界面");
	});

	it("allows an exact operation remembered for this session only", () => {
		const first = evaluate(tool("bash"), { command: "git reset --hard" });
		const approved = new Set([first.fingerprint]);
		expect(evaluate(tool("bash"), { command: "git reset --hard" }, { approved }).action).toBe("allow");
		expect(evaluate(tool("bash"), { command: "git reset --hard HEAD~1" }, { approved }).action).toBe("prompt");
	});

	it("does not remember oversized operation arguments", () => {
		const result = evaluate(tool("bash"), { command: `git reset --hard ${"x".repeat(20_000)}` });
		expect(result.action).toBe("prompt");
		expect(result.fingerprint).toBe("");
	});

	it("bounds and redacts approval details", () => {
		const result = evaluate({
			name: "custom",
			approval: "exec",
			formatApprovalDetails: () => `Bearer secret-token ${"x".repeat(4_000)}`,
		});
		expect(result.details.join(" ")).not.toContain("secret-token");
		expect(result.details.join(" ")).toContain("[已隐藏]");
		expect(result.details.join(" ").length).toBeLessThanOrEqual(2_100);
	});
});
