import { describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { sandboxController } from "../src/core/sandbox/controller.ts";
import { buildBashToolCommand, createBashToolDefinition, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { selectGitBashNearGit, selectUsableWindowsBashPath } from "../src/utils/shell.ts";

describe("shell routing", () => {
	test("keeps portable commands in bash", () => {
		expect(buildBashToolCommand("npm run check", "bash", "win32")).toBe("npm run check");
	});

	test("keeps PowerShell source intact for the native executor", () => {
		expect(buildBashToolCommand("Get-ChildItem Env:", "powershell", "win32")).toBe("Get-ChildItem Env:");
		expect(buildBashToolCommand("Get-Item '$env:TEMP'", "powershell", "win32")).toBe("Get-Item '$env:TEMP'");
	});

	test("passes the executor separately from the command source", async () => {
		let receivedCommand: string | undefined;
		let receivedExecutor: string | undefined;
		const tool = createBashToolDefinition(process.cwd(), {
			operations: {
				exec: async (command, _cwd, options) => {
					receivedCommand = command;
					receivedExecutor = options.executor;
					return { exitCode: 0 };
				},
			},
		});

		await tool.execute(
			"executor-test",
			{ command: "printf executor-ok", executor: "bash" },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);

		expect(receivedCommand).toBe("printf executor-ok");
		expect(receivedExecutor).toBe("bash");
	});

	test("maps an interactive exact-destination network choice into the command scope", async () => {
		const select = vi.fn(async () => "Allow for this command");
		let decision: string | undefined;
		const tool = createBashToolDefinition(process.cwd(), {
			exposeSessionEnvironment: false,
			operations: {
				exec: async (_command, _cwd, options) => {
					decision = await options.requestNetworkAccess?.({
						host: "example.com",
						port: 443,
						destination: "example.com:443",
					});
					return { exitCode: 0 };
				},
			},
		});
		const ctx = { hasUI: true, ui: { select } } as unknown as ExtensionContext;

		await tool.execute("network-test", { command: "curl https://example.com" }, undefined, undefined, ctx);

		expect(decision).toBe("allow-command");
		expect(select).toHaveBeenCalledWith(expect.stringContaining("example.com:443"), expect.any(Array), undefined);
	});

	test.skipIf(process.platform !== "win32")("runs PowerShell directly without Git Bash or WSL", async () => {
		const previousMode = process.env.PI_SANDBOX_MODE;
		process.env.PI_SANDBOX_MODE = "full-access";
		await sandboxController.reset();
		try {
			const chunks: Buffer[] = [];
			const result = await createLocalBashOperations().exec("Write-Output 'native-ok'", process.cwd(), {
				onData: (data) => chunks.push(data),
				executor: "powershell",
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf8")).toContain("native-ok");
		} finally {
			if (previousMode === undefined) delete process.env.PI_SANDBOX_MODE;
			else process.env.PI_SANDBOX_MODE = previousMode;
			await sandboxController.reset();
		}
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
