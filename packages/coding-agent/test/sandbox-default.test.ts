import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxBackend } from "../src/core/sandbox/controller.ts";
import { SandboxController } from "../src/core/sandbox/controller.ts";
import { DefaultSandboxRegistry, resolveDefaultSandboxMode } from "../src/core/sandbox/default.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("default sandbox mode", () => {
	it("uses auto without user configuration", () => {
		expect(resolveDefaultSandboxMode({})).toBe("auto");
	});

	it.each(["auto", "read-only", "full-access"] as const)("accepts %s", (mode) => {
		expect(resolveDefaultSandboxMode({ PI_SANDBOX_MODE: mode })).toBe(mode);
	});

	it("rejects unknown modes instead of falling back to host execution", () => {
		expect(() => resolveDefaultSandboxMode({ PI_SANDBOX_MODE: "disabled" })).toThrow("Invalid PI_SANDBOX_MODE");
	});

	it("checks direct file access without waiting for process sandbox initialization", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-default-sandbox-"));
		temporaryDirectories.push(root);
		const workspace = path.join(root, "workspace");
		const userHome = path.join(root, "home");
		const agentDir = path.join(root, "agent");
		await Promise.all([mkdir(workspace), mkdir(userHome), mkdir(agentDir)]);
		let release: (() => void) | undefined;
		const backend: SandboxBackend = {
			name: "slow-backend",
			initialize: async () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
			async prepare(request) {
				return { ...request, env: request.env };
			},
			async reset() {},
		};
		const registry = new DefaultSandboxRegistry({
			agentDir,
			tempRoot: path.join(root, "temp"),
			userHome,
			environment: { PI_SANDBOX_MODE: "auto" },
			controllerFactory: () => new SandboxController(() => backend),
		});

		const initialization = registry.ensure(workspace);
		const expectedPath = path.resolve(workspace, "answer.txt");
		await expect(registry.checkPath(workspace, expectedPath, "write")).resolves.toBe(
			process.platform === "win32" ? expectedPath.toLowerCase() : expectedPath,
		);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		release?.();
		await initialization;
	});
});
