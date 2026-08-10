import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type SandboxBackend,
	type SandboxBackendContext,
	SandboxController,
	type SandboxProcessRequest,
} from "../src/core/sandbox/controller.ts";
import { spawnSandboxedProcess } from "../src/core/sandbox/process.ts";

const temporaryDirectories: string[] = [];

async function roots() {
	const root = await mkdtemp(path.join(tmpdir(), "pi-sandbox-controller-"));
	temporaryDirectories.push(root);
	const workspaceRoot = path.join(root, "workspace");
	const sandboxTempRoot = path.join(root, "temp");
	const userHome = path.join(root, "home");
	await Promise.all([mkdir(workspaceRoot), mkdir(sandboxTempRoot), mkdir(userHome)]);
	return { workspaceRoot, sandboxTempRoot, userHome };
}

function fakeBackend(overrides: Partial<SandboxBackend> = {}): SandboxBackend & {
	contexts: SandboxBackendContext[];
	requests: SandboxProcessRequest[];
} {
	const contexts: SandboxBackendContext[] = [];
	const requests: SandboxProcessRequest[] = [];
	return {
		name: "fake-os",
		contexts,
		requests,
		async initialize(context) {
			contexts.push(context);
		},
		async prepare(request) {
			requests.push(request);
			return {
				command: "sandbox-helper",
				args: [request.command, ...request.args],
				cwd: request.cwd,
				env: request.env,
			};
		},
		async reset() {},
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("SandboxController", () => {
	it("coalesces concurrent initialization and publishes an enforced snapshot", async () => {
		const fixture = await roots();
		let release: (() => void) | undefined;
		const backend = fakeBackend({
			initialize: async (context) => {
				backend.contexts.push(context);
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			},
		});
		const controller = new SandboxController(() => backend);
		const options = { mode: "auto" as const, ...fixture, platform: process.platform };

		const first = controller.initialize(options);
		const second = controller.initialize(options);
		await vi.waitFor(() => expect(backend.contexts).toHaveLength(1));
		release?.();
		await Promise.all([first, second]);

		expect(controller.snapshot()).toMatchObject({
			state: "active",
			mode: "auto",
			backend: "fake-os",
			enforced: true,
		});
	});

	it("sanitizes environment state before preparing a process", async () => {
		const fixture = await roots();
		const backend = fakeBackend();
		const controller = new SandboxController(() => backend);
		await controller.initialize({ mode: "auto", ...fixture });

		const prepared = await controller.prepare({
			command: "node",
			args: ["script.js"],
			cwd: fixture.workspaceRoot,
			env: { PATH: process.env.PATH, OPENAI_API_KEY: "secret", NODE_OPTIONS: "--require inject.js" },
		});

		expect(prepared.command).toBe("sandbox-helper");
		const preparedEnvironment = backend.requests[0]?.env;
		expect(preparedEnvironment).toBeDefined();
		expect(preparedEnvironment).not.toHaveProperty("OPENAI_API_KEY");
		expect(preparedEnvironment).not.toHaveProperty("NODE_OPTIONS");
		expect(preparedEnvironment?.SANDBOX_RUNTIME).toBe("1");
	});

	it("fails closed before initialization and after a backend error", async () => {
		const fixture = await roots();
		const backend = fakeBackend({ initialize: async () => Promise.reject(new Error("backend unavailable")) });
		const controller = new SandboxController(() => backend);
		const request = { command: "node", args: [], cwd: fixture.workspaceRoot };

		await expect(controller.prepare(request)).rejects.toThrow("not initialized");
		await expect(controller.initialize({ mode: "auto", ...fixture })).rejects.toThrow("backend unavailable");
		await expect(controller.prepare(request)).rejects.toThrow("backend unavailable");
		expect(controller.snapshot()).toMatchObject({ state: "failed", enforced: false });
	});

	it("uses direct host execution only for explicit full-access mode", async () => {
		const fixture = await roots();
		const backendFactory = vi.fn(() => fakeBackend());
		const controller = new SandboxController(backendFactory);
		await controller.initialize({ mode: "full-access", ...fixture });
		const environment = { PATH: process.env.PATH, OPENAI_API_KEY: "explicit-host-secret" };

		const prepared = await controller.prepare({
			command: "node",
			args: ["script.js"],
			cwd: fixture.workspaceRoot,
			env: environment,
		});

		expect(backendFactory).not.toHaveBeenCalled();
		expect(prepared).toEqual({ command: "node", args: ["script.js"], cwd: fixture.workspaceRoot, env: environment });
		expect(controller.snapshot()).toMatchObject({
			state: "active",
			mode: "full-access",
			backend: "host",
			enforced: false,
		});
	});

	it("does not call spawn when broker preparation is rejected", async () => {
		const fixture = await roots();
		const controller = new SandboxController(() => fakeBackend());
		const spawn = vi.fn<(command: string, args: readonly string[], options: SpawnOptions) => ChildProcess>();

		await expect(
			spawnSandboxedProcess("node", [], { cwd: fixture.workspaceRoot, stdio: "ignore" }, controller, spawn),
		).rejects.toThrow("not initialized");
		expect(spawn).not.toHaveBeenCalled();
	});
});
