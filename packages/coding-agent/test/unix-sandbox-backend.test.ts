import { describe, expect, it, vi } from "vitest";
import type { SandboxBackendContext } from "../src/core/sandbox/controller.ts";
import { compileSandboxPolicy } from "../src/core/sandbox/policy.ts";
import { UnixSandboxBackend, type UnixSandboxRuntime } from "../src/core/sandbox/unix-backend.ts";

async function context(): Promise<SandboxBackendContext> {
	return {
		policy: await compileSandboxPolicy({
			mode: "auto",
			workspaceRoot: process.cwd(),
			sandboxTempRoot: process.cwd(),
			userHome: process.cwd(),
		}),
		requestNetworkAccess: vi.fn(async (host) => host === "registry.npmjs.org"),
	};
}

function fakeRuntime(): UnixSandboxRuntime & {
	initialize: ReturnType<typeof vi.fn<UnixSandboxRuntime["initialize"]>>;
	wrapWithSandbox: ReturnType<typeof vi.fn<UnixSandboxRuntime["wrapWithSandbox"]>>;
	reset: ReturnType<typeof vi.fn<UnixSandboxRuntime["reset"]>>;
} {
	return {
		initialize: vi.fn(async () => {}),
		wrapWithSandbox: vi.fn(async (command) => `wrapped ${command}`),
		reset: vi.fn(async () => {}),
	};
}

describe("UnixSandboxBackend", () => {
	it("translates the neutral policy into deny-by-default network and bounded filesystem rules", async () => {
		const runtime = fakeRuntime();
		const backend = new UnixSandboxBackend(runtime);
		const sandboxContext = await context();

		await backend.initialize(sandboxContext);

		expect(runtime.initialize).toHaveBeenCalledOnce();
		const [config, ask] = runtime.initialize.mock.calls[0] ?? [];
		const workspace = sandboxContext.policy.workspaceRoot.replaceAll("\\", "/");
		expect(config?.network).toMatchObject({ allowedDomains: [], deniedDomains: [], allowLocalBinding: false });
		expect(config?.filesystem.allowWrite).toEqual(sandboxContext.policy.writeRoots);
		expect(config?.filesystem.denyWrite).toEqual(
			expect.arrayContaining([`${workspace}/.git`, `${workspace}/.pi`, `${workspace}/.env`]),
		);
		expect(await ask?.({ host: "registry.npmjs.org", port: 443 })).toBe(true);
		expect(await ask?.({ host: "metadata.google.internal", port: 80 })).toBe(false);
	});

	it("preserves argv through one sandboxed shell wrapper", async () => {
		const runtime = fakeRuntime();
		const backend = new UnixSandboxBackend(runtime);
		await backend.initialize(await context());

		const prepared = await backend.prepare({
			command: "/opt/My Tool/bin/tool",
			args: ["two words", "$(touch escaped)"],
			cwd: process.cwd(),
			env: { SANDBOX_RUNTIME: "1" },
		});

		expect(runtime.wrapWithSandbox).toHaveBeenCalledWith(
			"'/opt/My Tool/bin/tool' 'two words' '$(touch escaped)'",
			"/bin/bash",
			undefined,
			undefined,
		);
		expect(prepared).toEqual({
			command: "/bin/bash",
			args: ["-c", "wrapped '/opt/My Tool/bin/tool' 'two words' '$(touch escaped)'"],
			cwd: process.cwd(),
			env: { SANDBOX_RUNTIME: "1" },
		});
	});

	it("resets the runtime and refuses preparation before initialization", async () => {
		const runtime = fakeRuntime();
		const backend = new UnixSandboxBackend(runtime);
		const request = { command: "true", args: [], cwd: process.cwd(), env: {} };

		await expect(backend.prepare(request)).rejects.toThrow("not initialized");
		await backend.initialize(await context());
		await backend.reset();
		expect(runtime.reset).toHaveBeenCalledOnce();
		await expect(backend.prepare(request)).rejects.toThrow("not initialized");
	});
});
