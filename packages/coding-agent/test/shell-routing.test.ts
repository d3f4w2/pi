import { describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { buildBashToolCommand, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { selectGitBashNearGit, selectUsableWindowsBashPath } from "../src/utils/shell.ts";

describe("shell routing", () => {
	test("keeps portable commands in bash", () => {
		expect(buildBashToolCommand("npm run check", "bash", "win32")).toBe("npm run check");
	});

	test("wraps Windows-only commands with a non-interactive PowerShell child", () => {
		expect(buildBashToolCommand("Get-ChildItem Env:", "powershell", "win32")).toBe(
			"powershell.exe -NoProfile -NonInteractive -Command 'Get-ChildItem Env:'",
		);
		expect(buildBashToolCommand("Get-Item '$env:TEMP'", "powershell", "win32")).toContain("'\"'\"'");
	});

	test("passes the wrapped PowerShell command to the configured bash backend", async () => {
		let receivedCommand: string | undefined;
		const tool = createBashToolDefinition(process.cwd(), {
			operations: {
				exec: async (command) => {
					receivedCommand = command;
					return { exitCode: 0 };
				},
			},
		});

		await tool.execute(
			"powershell-test",
			{ command: "Get-ChildItem Env:", executor: "powershell" },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);

		expect(receivedCommand).toBe("powershell.exe -NoProfile -NonInteractive -Command 'Get-ChildItem Env:'");
	});

	test("rejects the PowerShell executor outside Windows", () => {
		expect(() => buildBashToolCommand("Get-ChildItem", "powershell", "linux")).toThrow("Windows");
	});

	test("skips the WSL relay and chooses a real Windows bash", () => {
		expect(
			selectUsableWindowsBashPath(
				["C:\\Windows\\System32\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"],
				() => true,
			),
		).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
	});

	test("finds Git Bash beside a non-standard git.exe installation", () => {
		expect(
			selectGitBashNearGit(
				["D:\\app\\Git\\cmd\\git.exe"],
				(candidate) => candidate.toLowerCase() === "d:\\app\\git\\bin\\bash.exe",
			),
		).toBe("D:\\app\\Git\\bin\\bash.exe");
	});
});
