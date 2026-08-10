import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSandboxPath, compileSandboxPolicy, type SandboxMode } from "../src/core/sandbox/policy.ts";

const temporaryDirectories: string[] = [];

async function fixture(mode: SandboxMode) {
	const root = await mkdtemp(path.join(tmpdir(), "pi-sandbox-policy-"));
	temporaryDirectories.push(root);
	const workspaceRoot = path.join(root, "workspace");
	const sandboxTempRoot = path.join(root, "sandbox-temp");
	const userHome = path.join(root, "home");
	const controlRoot = path.join(userHome, ".pi", "agent");
	await Promise.all([
		mkdir(path.join(workspaceRoot, "src"), { recursive: true }),
		mkdir(sandboxTempRoot, { recursive: true }),
		mkdir(path.join(userHome, ".ssh"), { recursive: true }),
		mkdir(controlRoot, { recursive: true }),
	]);
	return {
		root,
		workspaceRoot,
		sandboxTempRoot,
		userHome,
		controlRoot,
		policy: await compileSandboxPolicy({
			mode,
			workspaceRoot,
			sandboxTempRoot,
			userHome,
			controlRoots: [controlRoot],
		}),
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("sandbox path policy", () => {
	it("allows normal workspace reads and writes in auto mode", async () => {
		const { policy, workspaceRoot } = await fixture("auto");
		const source = path.join(workspaceRoot, "src", "main.ts");

		expect((await checkSandboxPath(policy, source, "read")).allowed).toBe(true);
		expect((await checkSandboxPath(policy, source, "write")).allowed).toBe(true);
	});

	it("protects control and credential files inside writable roots", async () => {
		const { policy, workspaceRoot } = await fixture("auto");
		const protectedPaths = [
			path.join(workspaceRoot, ".git", "config"),
			path.join(workspaceRoot, ".pi", "settings.json"),
			path.join(workspaceRoot, ".env"),
			path.join(workspaceRoot, "service", ".env.production"),
		];

		for (const protectedPath of protectedPaths) {
			expect((await checkSandboxPath(policy, protectedPath, "write")).allowed).toBe(false);
		}
		expect((await checkSandboxPath(policy, path.join(workspaceRoot, ".pi", "settings.json"), "read")).allowed).toBe(
			false,
		);
		expect((await checkSandboxPath(policy, path.join(workspaceRoot, ".env"), "read")).allowed).toBe(false);
	});

	it("keeps read-only mode usable through a private temporary directory", async () => {
		const { policy, workspaceRoot, sandboxTempRoot } = await fixture("read-only");

		expect((await checkSandboxPath(policy, path.join(workspaceRoot, "src", "main.ts"), "read")).allowed).toBe(true);
		expect((await checkSandboxPath(policy, path.join(workspaceRoot, "src", "main.ts"), "write")).allowed).toBe(false);
		expect((await checkSandboxPath(policy, path.join(sandboxTempRoot, "command.log"), "write")).allowed).toBe(true);
	});

	it("denies reads and writes outside explicit roots", async () => {
		const { policy, userHome, controlRoot } = await fixture("auto");
		const privateKey = path.join(userHome, ".ssh", "id_ed25519");
		const kubeConfig = path.join(userHome, ".kube", "config");

		expect((await checkSandboxPath(policy, privateKey, "read")).allowed).toBe(false);
		expect((await checkSandboxPath(policy, privateKey, "write")).allowed).toBe(false);
		expect((await checkSandboxPath(policy, kubeConfig, "read")).allowed).toBe(false);
		expect(policy.deniedReadRoots).toContain(path.resolve(controlRoot).toLowerCase());
	});

	it("does not let a workspace junction broaden access", async () => {
		const { policy, root, workspaceRoot } = await fixture("auto");
		const outside = path.join(root, "outside");
		const escapePath = path.join(workspaceRoot, "escape");
		await mkdir(outside);
		await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
		await symlink(outside, escapePath, process.platform === "win32" ? "junction" : "dir");

		expect((await checkSandboxPath(policy, path.join(escapePath, "secret.txt"), "read")).allowed).toBe(false);
		expect((await checkSandboxPath(policy, path.join(escapePath, "new.txt"), "write")).allowed).toBe(false);
	});

	it("allows all paths only in explicit full-access mode", async () => {
		const { policy, userHome } = await fixture("full-access");

		expect((await checkSandboxPath(policy, path.join(userHome, ".ssh", "id_ed25519"), "read")).allowed).toBe(true);
		expect((await checkSandboxPath(policy, path.join(userHome, ".ssh", "id_ed25519"), "write")).allowed).toBe(true);
	});
});
