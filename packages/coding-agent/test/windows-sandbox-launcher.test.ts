import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSandboxLaunchRequest } from "../src/core/sandbox/command.ts";
import type { SandboxBackendContext } from "../src/core/sandbox/controller.ts";
import { createSandboxEnvironment } from "../src/core/sandbox/environment.ts";
import { compileSandboxPolicy } from "../src/core/sandbox/policy.ts";
import { WindowsSandboxBackend, type WindowsSandboxBackendOptions } from "../src/core/sandbox/windows-backend.ts";

const temporaryDirectories: string[] = [];

async function fixture(mode: "auto" | "read-only" = "auto") {
	const root = await mkdtemp(path.join(tmpdir(), "pi-windows-sandbox-"));
	temporaryDirectories.push(root);
	const workspaceRoot = path.join(root, "workspace");
	const sandboxTempRoot = path.join(root, "temp");
	const userHome = path.join(root, "home");
	const scriptPath = path.join(root, "pi-sandbox.ps1");
	await Promise.all([
		mkdir(workspaceRoot),
		mkdir(sandboxTempRoot),
		mkdir(userHome),
		writeFile(scriptPath, "# test", "utf8"),
	]);
	const context: SandboxBackendContext = {
		policy: await compileSandboxPolicy({ mode, workspaceRoot, sandboxTempRoot, userHome }),
	};
	return { context, scriptPath, workspaceRoot, sandboxTempRoot, controlRoot: path.join(root, "control") };
}

function options(
	scriptPath: string,
	overrides: Partial<WindowsSandboxBackendOptions> = {},
): WindowsSandboxBackendOptions {
	return {
		scriptPath,
		controlRoot: path.join(path.dirname(scriptPath), "control"),
		powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		probe: vi.fn(async () => {}),
		resolveExecutable: vi.fn(async () => "C:\\Program Files\\Git\\bin\\bash.exe"),
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("WindowsSandboxBackend", () => {
	it("probes the bundled launcher during initialization", async () => {
		const { context, scriptPath } = await fixture();
		const backendOptions = options(scriptPath);
		const backend = new WindowsSandboxBackend(backendOptions);

		await backend.initialize(context);

		expect(backendOptions.probe).toHaveBeenCalledWith(
			backendOptions.powershellPath,
			expect.stringMatching(/[\\/]control[\\/]launchers[\\/][a-f0-9]{64}\.ps1$/),
		);
	});

	it("encodes only explicit roots and launches through the trusted script", async () => {
		const { context, scriptPath, workspaceRoot } = await fixture();
		const backend = new WindowsSandboxBackend(options(scriptPath));
		await backend.initialize(context);

		const prepared = await backend.prepare({
			command: "bash.exe",
			args: ["-lc", "printf '%s' 'two words'"],
			cwd: workspaceRoot,
			env: { PATH: "C:\\Program Files\\Git\\bin;C:\\Windows\\System32", SANDBOX_RUNTIME: "1" },
		});

		expect(prepared.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(prepared.args.slice(0, -1)).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			expect.stringMatching(/[\\/]control[\\/]launchers[\\/][a-f0-9]{64}\.ps1$/),
			"-Request",
		]);
		const request = decodeSandboxLaunchRequest(prepared.args.at(-1) ?? "");
		expect(request).toMatchObject({
			command: "C:\\Program Files\\Git\\bin\\bash.exe",
			cwd: workspaceRoot,
			workspaceRoot: context.policy.workspaceRoot,
			tempRoot: context.policy.sandboxTempRoot,
			readOnly: false,
		});
		expect(request.protectedWritePaths).toEqual(
			expect.arrayContaining([
				path.win32.join(context.policy.workspaceRoot, ".git"),
				path.win32.join(context.policy.workspaceRoot, ".pi"),
			]),
		);
		expect(prepared.env).toEqual({
			PATH: "C:\\Program Files\\Git\\bin;C:\\Windows\\System32",
			SANDBOX_RUNTIME: "1",
		});
	});

	it("fails closed if the private launcher copy is modified", async () => {
		const { context, scriptPath, workspaceRoot } = await fixture();
		const probe = vi.fn<NonNullable<WindowsSandboxBackendOptions["probe"]>>(async () => {});
		const backendOptions = options(scriptPath, { probe });
		const backend = new WindowsSandboxBackend(backendOptions);
		await backend.initialize(context);
		const launcherPath = probe.mock.calls[0]?.[1];
		expect(launcherPath).toBeDefined();
		await writeFile(launcherPath ?? "", "tampered", "utf8");

		await expect(backend.prepare({ command: "cmd.exe", args: [], cwd: workspaceRoot, env: {} })).rejects.toThrow(
			"launcher integrity check failed",
		);
	});

	it.skipIf(process.platform !== "win32")(
		"forwards stdin and stdout to native PowerShell",
		async () => {
			const { context, workspaceRoot, sandboxTempRoot } = await fixture();
			const backend = new WindowsSandboxBackend();
			await backend.initialize(context);
			const powershell = path.join(
				process.env.SystemRoot ?? "C:\\Windows",
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			);
			const prepared = await backend.prepare({
				command: powershell,
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
				cwd: workspaceRoot,
				env: createSandboxEnvironment(process.env, { tempRoot: sandboxTempRoot, platform: "win32" }),
			});

			const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
				(resolve, reject) => {
					const child = spawn(prepared.command, prepared.args, {
						cwd: prepared.cwd,
						env: prepared.env,
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
					});
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (chunk: Buffer) => {
						stdout += chunk.toString("utf8");
					});
					child.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString("utf8");
					});
					child.once("error", reject);
					child.once("close", (code) => resolve({ code, stdout, stderr }));
					child.stdin.end("Write-Output 'sandbox-stdin'\n");
				},
			);

			expect(result, result.stderr).toMatchObject({ code: 0 });
			expect(result.stdout).toContain("sandbox-stdin");
		},
		30_000,
	);

	it("propagates launcher probe failures and read-only mode", async () => {
		const { context, scriptPath, workspaceRoot } = await fixture("read-only");
		const failing = new WindowsSandboxBackend(
			options(scriptPath, { probe: vi.fn(async () => Promise.reject(new Error("AppContainer unavailable"))) }),
		);
		await expect(failing.initialize(context)).rejects.toThrow("AppContainer unavailable");

		const backend = new WindowsSandboxBackend(options(scriptPath));
		await backend.initialize(context);
		const prepared = await backend.prepare({ command: "cmd.exe", args: [], cwd: workspaceRoot, env: {} });
		expect(decodeSandboxLaunchRequest(prepared.args.at(-1) ?? "").readOnly).toBe(true);
	});

	it.skipIf(process.platform !== "win32")(
		"enforces restricted-token workspace write boundaries without elevation",
		async () => {
			const { context, workspaceRoot, sandboxTempRoot } = await fixture();
			const protectedDirectory = path.join(workspaceRoot, ".pi");
			const protectedFile = path.join(protectedDirectory, "settings.json");
			const outsideFile = path.join(path.dirname(workspaceRoot), "outside-secret.txt");
			const outsideWriteFile = path.join(path.dirname(workspaceRoot), "outside-write.txt");
			const allowedFile = path.join(workspaceRoot, "allowed.txt");
			const scriptPath = path.join(workspaceRoot, "sandbox-test.cmd");
			await mkdir(protectedDirectory);
			await Promise.all([
				writeFile(protectedFile, "protected", "utf8"),
				writeFile(outsideFile, "outside-secret", "utf8"),
			]);
			const backend = new WindowsSandboxBackend();
			await backend.initialize(context);
			const commandPrompt = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
			const script = [
				`@(echo allowed > "${allowedFile}") || (exit /b 8)`,
				`@(type "${outsideFile}" >nul 2>&1) || (exit /b 9)`,
				`@(echo changed > "${outsideWriteFile}" 2>nul) && (exit /b 10)`,
				`@(echo changed > "${protectedFile}" 2>nul) && (exit /b 11)`,
				"echo sandbox-ok",
				"exit /b 0",
			].join("\r\n");
			await writeFile(scriptPath, script, "utf8");
			const environment = createSandboxEnvironment(process.env, {
				tempRoot: sandboxTempRoot,
				platform: "win32",
			});
			const prepared = await backend.prepare({
				command: commandPrompt,
				args: ["/d", "/c", scriptPath],
				cwd: workspaceRoot,
				env: environment,
			});

			const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
				(resolve, reject) => {
					const child = spawn(prepared.command, prepared.args, {
						cwd: prepared.cwd,
						env: prepared.env,
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					});
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (chunk: Buffer) => {
						stdout += chunk.toString("utf8");
					});
					child.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString("utf8");
					});
					child.once("error", reject);
					child.once("close", (code) => resolve({ code, stdout, stderr }));
				},
			);

			expect(result, result.stderr).toMatchObject({ code: 0 });
			expect(result.stdout).toContain("sandbox-ok");
		},
		30_000,
	);

	it.skipIf(process.platform !== "win32")(
		"keeps the workspace read-only while allowing the private temporary directory",
		async () => {
			const { context, workspaceRoot, sandboxTempRoot } = await fixture("read-only");
			const deniedFile = path.join(workspaceRoot, "denied.txt");
			const allowedTempFile = path.join(sandboxTempRoot, "allowed.txt");
			const scriptPath = path.join(workspaceRoot, "read-only-test.cmd");
			await writeFile(
				scriptPath,
				[
					`@(echo changed > "${deniedFile}" 2>nul) && (exit /b 8)`,
					`@(echo allowed > "${allowedTempFile}") || (exit /b 9)`,
					"echo readonly-ok",
				].join("\r\n"),
				"utf8",
			);
			const backend = new WindowsSandboxBackend();
			await backend.initialize(context);
			const commandPrompt = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
			const prepared = await backend.prepare({
				command: commandPrompt,
				args: ["/d", "/c", scriptPath],
				cwd: workspaceRoot,
				env: createSandboxEnvironment(process.env, { tempRoot: sandboxTempRoot, platform: "win32" }),
			});

			const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
				(resolve, reject) => {
					const child = spawn(prepared.command, prepared.args, {
						cwd: prepared.cwd,
						env: prepared.env,
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					});
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (chunk: Buffer) => {
						stdout += chunk.toString("utf8");
					});
					child.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString("utf8");
					});
					child.once("error", reject);
					child.once("close", (code) => resolve({ code, stdout, stderr }));
				},
			);

			expect(result, result.stderr).toMatchObject({ code: 0 });
			expect(result.stdout).toContain("readonly-ok");
		},
		30_000,
	);
});
