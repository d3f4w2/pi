import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	checkWindowsSandboxStatus,
	resolveSrtWin,
	VENDORED_SRT_WIN_EXE,
	type WindowsSandboxStatus,
} from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SandboxBackend, type SandboxBackendContext, SandboxController } from "../src/core/sandbox/controller.ts";
import { compileSandboxPolicy } from "../src/core/sandbox/policy.ts";
import {
	WindowsAutoSandboxBackend,
	type WindowsSrtRuntime,
	WindowsSrtSandboxBackend,
} from "../src/core/sandbox/windows-srt-backend.ts";

const temporaryDirectories: string[] = [];

function installedWindowsSrtAvailable(): boolean {
	if (process.platform !== "win32") return false;
	try {
		const status = checkWindowsSandboxStatus({
			srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }),
		});
		return status.user.provisioned && status.user.credPresent;
	} catch {
		return false;
	}
}

const runInstalledWindowsSrtTest = installedWindowsSrtAvailable();

async function fixture(): Promise<SandboxBackendContext> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-windows-srt-"));
	temporaryDirectories.push(root);
	const workspaceRoot = path.join(root, "workspace");
	const sandboxTempRoot = path.join(root, "temp");
	const userHome = path.join(root, "home");
	await Promise.all([mkdir(workspaceRoot), mkdir(sandboxTempRoot), mkdir(userHome)]);
	return {
		policy: await compileSandboxPolicy({
			mode: "auto",
			workspaceRoot,
			sandboxTempRoot,
			userHome,
			platform: "win32",
		}),
	};
}

function fakeBackend(name: string): SandboxBackend & { initialize: ReturnType<typeof vi.fn> } {
	return {
		name,
		initialize: vi.fn(async () => {}),
		async prepare(request) {
			return { ...request, env: request.env };
		},
		async reset() {},
	};
}

function provisionedStatus(): WindowsSandboxStatus {
	return {
		user: {
			provisioned: true,
			groupExists: true,
			inBuiltinUsers: true,
			inSandboxGroup: true,
			hiddenFromLogon: true,
			credPresent: true,
			realUserSid: "S-1-5-21-test",
		},
		wfp: { state: "cannot-read", filters: 0 },
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("WindowsAutoSandboxBackend", () => {
	it("uses the separate-user backend when the one-time setup is provisioned", async () => {
		const context = await fixture();
		const strong = fakeBackend("srt-windows");
		const fallback = fakeBackend("restricted-token");
		const backend = new WindowsAutoSandboxBackend({
			status: vi.fn(async () => provisionedStatus()),
			strongBackend: strong,
			fallbackBackend: fallback,
		});

		await backend.initialize(context);

		expect(backend.name).toBe("srt-windows");
		expect(strong.initialize).toHaveBeenCalledWith(context);
		expect(fallback.initialize).not.toHaveBeenCalled();
	});

	it("uses the no-UAC restricted-token backend when setup is absent", async () => {
		const context = await fixture();
		const strong = fakeBackend("srt-windows");
		const fallback = fakeBackend("restricted-token");
		const backend = new WindowsAutoSandboxBackend({
			status: vi.fn(async () => undefined),
			strongBackend: strong,
			fallbackBackend: fallback,
		});

		await backend.initialize(context);

		expect(backend.name).toBe("restricted-token");
		expect(fallback.initialize).toHaveBeenCalledWith(context);
		expect(strong.initialize).not.toHaveBeenCalled();
	});

	it("does not downgrade after a provisioned strong backend fails", async () => {
		const context = await fixture();
		const strong = fakeBackend("srt-windows");
		strong.initialize.mockRejectedValueOnce(new Error("WFP fence inactive"));
		const fallback = fakeBackend("restricted-token");
		const backend = new WindowsAutoSandboxBackend({
			status: vi.fn(async () => provisionedStatus()),
			strongBackend: strong,
			fallbackBackend: fallback,
		});

		await expect(backend.initialize(context)).rejects.toThrow("WFP fence inactive");
		expect(fallback.initialize).not.toHaveBeenCalled();
	});

	it("fails closed through the strong backend when setup is only partial", async () => {
		const context = await fixture();
		const strong = fakeBackend("srt-windows");
		strong.initialize.mockRejectedValueOnce(new Error("sandbox account is incomplete"));
		const fallback = fakeBackend("restricted-token");
		const status = provisionedStatus();
		status.user.provisioned = false;
		status.user.credPresent = false;
		const backend = new WindowsAutoSandboxBackend({
			status: vi.fn(async () => status),
			strongBackend: strong,
			fallbackBackend: fallback,
		});

		await expect(backend.initialize(context)).rejects.toThrow("sandbox account is incomplete");
		expect(fallback.initialize).not.toHaveBeenCalled();
	});
});

describe("WindowsSrtSandboxBackend", () => {
	it("configures filesystem and network isolation and returns direct argv", async () => {
		const context = await fixture();
		context.requestNetworkAccess = vi.fn(async (host, port) => host === "registry.npmjs.org" && port === 443);
		const fixtureRoot = path.dirname(context.policy.workspaceRoot);
		const sourceSrtWinPath = path.join(fixtureRoot, "source-srt-win.exe");
		const controlParent = path.join(fixtureRoot, "program-data", "pi-sandbox");
		await writeFile(sourceSrtWinPath, "trusted-srt-win", "utf8");
		const runtime: WindowsSrtRuntime = {
			initialize: vi.fn(async () => {}),
			wrapWithSandboxArgv: vi.fn(async () => ({
				argv: ["C:\\trusted\\srt-win.exe", "exec", "--", "powershell.exe"],
				env: { PATH: "C:\\Windows\\System32" },
			})),
			reset: vi.fn(async () => {}),
		};
		const backend = new WindowsSrtSandboxBackend({
			runtime,
			srtWinPath: sourceSrtWinPath,
			powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			controlParent,
		});
		await backend.initialize(context);
		const initializedConfig = vi.mocked(runtime.initialize).mock.calls[0]?.[0];
		const materializedSrtWinPath = initializedConfig?.windows?.srtWin?.path;
		expect(materializedSrtWinPath).toMatch(
			/program-data[\\/]pi-sandbox[\\/]session-.+[\\/]srt-win-[a-f0-9]{64}\.exe$/,
		);
		expect(await readFile(materializedSrtWinPath ?? "", "utf8")).toBe("trusted-srt-win");

		expect(runtime.initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				network: expect.objectContaining({ allowedDomains: [], allowLocalBinding: false }),
				filesystem: expect.objectContaining({
					allowRead: context.policy.readRoots,
					allowWrite: context.policy.writeRoots,
				}),
				windows: { srtWin: { path: materializedSrtWinPath } },
			}),
			expect.any(Function),
			false,
		);
		const ask = vi.mocked(runtime.initialize).mock.calls[0]?.[1];
		expect(await ask?.({ host: "registry.npmjs.org", port: 443 })).toBe(true);
		expect(await ask?.({ host: "registry.npmjs.org", port: 80 })).toBe(false);

		const prepared = await backend.prepare({
			command: "node.exe",
			args: ["script.js", "two words"],
			cwd: context.policy.workspaceRoot,
			env: { HOME: "C:\\private home", SANDBOX_RUNTIME: "1" },
		});

		expect(runtime.wrapWithSandboxArgv).toHaveBeenCalledWith(
			expect.stringContaining("& 'node.exe' 'script.js' 'two words'"),
			expect.objectContaining({ exe: expect.stringContaining("powershell.exe") }),
			undefined,
			undefined,
			context.policy.workspaceRoot,
		);
		expect(prepared).toEqual({
			command: "C:\\trusted\\srt-win.exe",
			args: ["exec", "--", "powershell.exe"],
			cwd: context.policy.workspaceRoot,
			env: { PATH: "C:\\Windows\\System32" },
		});

		await chmod(materializedSrtWinPath ?? "", 0o700);
		await writeFile(materializedSrtWinPath ?? "", "tampered", "utf8");
		await expect(
			backend.prepare({
				command: "node.exe",
				args: [],
				cwd: context.policy.workspaceRoot,
				env: {},
			}),
		).rejects.toThrow("integrity check failed");
		await backend.reset();
	});

	it.skipIf(!runInstalledWindowsSrtTest)(
		"enforces workspace writes and WFP egress with the installed backend",
		async () => {
			const context = await fixture();
			const fixtureRoot = path.dirname(context.policy.workspaceRoot);
			const allowedFile = path.join(context.policy.workspaceRoot, "allowed.txt");
			const outsideFile = path.join(fixtureRoot, "outside.txt");
			const server = createServer();
			let acceptedConnections = 0;
			server.on("connection", (socket) => {
				acceptedConnections++;
				socket.destroy();
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address() as AddressInfo;
			const controller = new SandboxController(() => new WindowsAutoSandboxBackend());
			const powerShell = path.join(
				process.env.SystemRoot ?? "C:\\Windows",
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			);
			const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
			const script = [
				"$ErrorActionPreference='Stop'",
				`Set-Content -LiteralPath ${quote(allowedFile)} -Value 'allowed'`,
				`try { Set-Content -LiteralPath ${quote(outsideFile)} -Value 'denied'; exit 8 } catch {}`,
				"$client=[System.Net.Sockets.TcpClient]::new()",
				`$pending=$client.BeginConnect('127.0.0.1', ${address.port}, $null, $null)`,
				"try { if ($pending.AsyncWaitHandle.WaitOne(2000)) { $client.EndConnect($pending); exit 9 } } catch {} finally { $pending.AsyncWaitHandle.Close(); $client.Dispose() }",
				"Write-Output 'srt-isolation-ok'",
			].join("; ");

			try {
				await controller.initialize({
					mode: "auto",
					workspaceRoot: context.policy.workspaceRoot,
					sandboxTempRoot: context.policy.sandboxTempRoot,
					userHome: context.policy.userHome,
					platform: "win32",
				});
				expect(controller.snapshot().backend).toBe("srt-windows");
				const prepared = await controller.prepare({
					command: powerShell,
					args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
					cwd: context.policy.workspaceRoot,
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
				expect(result.stdout).toContain("srt-isolation-ok");
				expect(await readFile(allowedFile, "utf8")).toContain("allowed");
				await expect(readFile(outsideFile)).rejects.toThrow();
				expect(acceptedConnections).toBe(0);
			} finally {
				await controller.reset();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
		30_000,
	);

	it.skipIf(!runInstalledWindowsSrtTest)(
		"routes an explicitly approved exact destination through the installed proxy",
		async () => {
			const context = await fixture();
			const server = createServer((socket) => {
				socket.once("data", () => {
					const body = "network-approved";
					socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
				});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address() as AddressInfo;
			const requestNetworkAccess = vi.fn(
				async (host: string, port: number | undefined) => host === "127.0.0.1" && port === address.port,
			);
			const controller = new SandboxController(() => new WindowsAutoSandboxBackend());
			const powerShell = path.join(
				process.env.SystemRoot ?? "C:\\Windows",
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			);
			const curl = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe");
			const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
			const url = `http://127.0.0.1:${address.port}/`;
			const script = [
				"$ErrorActionPreference='Stop'",
				"if (-not $env:HTTP_PROXY) { exit 7 }",
				`$body=& ${quote(curl)} --fail --silent --show-error --noproxy '' --proxy $env:HTTP_PROXY ${quote(url)}`,
				"if ($LASTEXITCODE -ne 0) { exit 8 }",
				"Write-Output $body",
			].join("; ");

			try {
				await controller.initialize({
					mode: "auto",
					workspaceRoot: context.policy.workspaceRoot,
					sandboxTempRoot: context.policy.sandboxTempRoot,
					userHome: context.policy.userHome,
					platform: "win32",
					requestNetworkAccess,
				});
				const prepared = await controller.prepare({
					command: powerShell,
					args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
					cwd: context.policy.workspaceRoot,
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
				expect(result.stdout).toContain("network-approved");
				expect(requestNetworkAccess).toHaveBeenCalledWith("127.0.0.1", address.port);
			} finally {
				await controller.reset();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
		30_000,
	);
});
