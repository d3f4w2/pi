import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isSensitiveSandboxNetworkHost,
	normalizeSandboxNetworkDestination,
	type SandboxNetworkAccessDecision,
	SandboxNetworkPermissionManager,
} from "../src/core/sandbox/network-permissions.ts";

const temporaryDirectories: string[] = [];

async function fixture(workspace = "workspace") {
	const root = await mkdtemp(path.join(tmpdir(), "pi-sandbox-network-"));
	temporaryDirectories.push(root);
	return {
		manager: new SandboxNetworkPermissionManager(path.join(root, workspace), {
			storageRoot: path.join(root, "permissions"),
		}),
		root,
		storageRoot: path.join(root, "permissions"),
		workspaceRoot: path.join(root, workspace),
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("sandbox network permissions", () => {
	it("normalizes exact host and port destinations and rejects ambiguous requests", () => {
		expect(normalizeSandboxNetworkDestination("API.Example.COM.", 443)).toEqual({
			host: "api.example.com",
			port: 443,
			destination: "api.example.com:443",
		});
		expect(normalizeSandboxNetworkDestination("::1", 8080)?.destination).toBe("[::1]:8080");
		expect(normalizeSandboxNetworkDestination("2852039166", 80)?.destination).toBe("169.254.169.254:80");
		expect(normalizeSandboxNetworkDestination("api.example.com", undefined)).toBeUndefined();
		expect(normalizeSandboxNetworkDestination("*.example.com", 443)).toBeUndefined();
		expect(normalizeSandboxNetworkDestination("api.example.com", 65_536)).toBeUndefined();
		expect(isSensitiveSandboxNetworkHost("169.254.169.254")).toBe(true);
		expect(isSensitiveSandboxNetworkHost("::ffff:127.0.0.1")).toBe(true);
		expect(isSensitiveSandboxNetworkHost("api.example.com")).toBe(false);
	});

	it("fails closed without one active interactive command", async () => {
		const { manager } = await fixture();
		const prompt = vi.fn(async (): Promise<SandboxNetworkAccessDecision> => "allow-command");

		expect(await manager.request("example.com", 443)).toBe(false);
		const first = manager.openCommand(prompt);
		const second = manager.openCommand();
		expect(await manager.request("example.com", 443)).toBe(false);
		expect(prompt).not.toHaveBeenCalled();
		first.close();
		second.close();
	});

	it("limits a command grant to the active command and caches denial", async () => {
		const { manager } = await fixture();
		const allowPrompt = vi.fn(async (): Promise<SandboxNetworkAccessDecision> => "allow-command");
		const command = manager.openCommand(allowPrompt);

		expect(await manager.request("example.com", 443)).toBe(true);
		expect(await manager.request("EXAMPLE.COM", 443)).toBe(true);
		expect(allowPrompt).toHaveBeenCalledTimes(1);
		command.close();
		expect(await manager.request("example.com", 443)).toBe(false);

		const denyPrompt = vi.fn(async (): Promise<SandboxNetworkAccessDecision> => "deny");
		const deniedCommand = manager.openCommand(denyPrompt);
		expect(await manager.request("example.com", 8443)).toBe(false);
		expect(await manager.request("example.com", 8443)).toBe(false);
		expect(denyPrompt).toHaveBeenCalledTimes(1);
		deniedCommand.close();
	});

	it("coalesces concurrent prompts for the same destination", async () => {
		const { manager } = await fixture();
		let resolveDecision: ((decision: SandboxNetworkAccessDecision) => void) | undefined;
		const prompt = vi.fn(
			() =>
				new Promise<SandboxNetworkAccessDecision>((resolve) => {
					resolveDecision = resolve;
				}),
		);
		const command = manager.openCommand(prompt);

		const first = manager.request("example.com", 443);
		const second = manager.request("example.com", 443);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		resolveDecision?.("allow-command");
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
		command.close();
	});

	it("serializes distinct prompts and bounds prompt volume per command", async () => {
		const { manager } = await fixture();
		let releaseFirst: (() => void) | undefined;
		const prompt = vi.fn(async ({ host }: { host: string }) => {
			if (host === "one.example.com") {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
			}
			return "deny" as const;
		});
		const command = manager.openCommand(prompt);
		const first = manager.request("one.example.com", 443);
		const second = manager.request("two.example.com", 443);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
		releaseFirst?.();
		await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
		expect(prompt).toHaveBeenCalledTimes(2);

		for (let index = 3; index <= 9; index++) {
			expect(await manager.request(`${index}.example.com`, 443)).toBe(false);
		}
		expect(prompt).toHaveBeenCalledTimes(8);
		command.close();
	});

	it("keeps session grants in memory and scopes persistent grants to one workspace and port", async () => {
		const { manager, storageRoot, workspaceRoot } = await fixture();
		const sessionCommand = manager.openCommand(async () => "allow-session");
		expect(await manager.request("registry.example.com", 443)).toBe(true);
		sessionCommand.close();
		const nextCommand = manager.openCommand();
		expect(await manager.request("registry.example.com", 443)).toBe(true);
		nextCommand.close();

		const persistentCommand = manager.openCommand(async () => "allow-workspace");
		expect(await manager.request("api.example.com", 443)).toBe(true);
		persistentCommand.close();

		const reloaded = new SandboxNetworkPermissionManager(workspaceRoot, { storageRoot });
		const reloadedCommand = reloaded.openCommand();
		expect(await reloaded.request("api.example.com", 443)).toBe(true);
		expect(await reloaded.request("api.example.com", 80)).toBe(false);
		reloadedCommand.close();
		const otherWorkspace = new SandboxNetworkPermissionManager(`${workspaceRoot}-other`, { storageRoot });
		const otherCommand = otherWorkspace.openCommand();
		expect(await otherWorkspace.request("api.example.com", 443)).toBe(false);
		otherCommand.close();
	});

	it("treats a corrupted persistent record as denied", async () => {
		const { manager, storageRoot, workspaceRoot } = await fixture();
		const command = manager.openCommand(async () => "allow-workspace");
		expect(await manager.request("example.com", 443)).toBe(true);
		command.close();

		const [workspaceDirectory] = await readdir(storageRoot);
		expect(workspaceDirectory).toBeDefined();
		const permissionDirectory = path.join(storageRoot, workspaceDirectory!);
		const [permissionFile] = await readdir(permissionDirectory);
		expect(permissionFile).toBeDefined();
		await writeFile(path.join(permissionDirectory, permissionFile!), "{}\n", "utf8");

		const reloaded = new SandboxNetworkPermissionManager(workspaceRoot, { storageRoot });
		const reloadedCommand = reloaded.openCommand();
		expect(await reloaded.request("example.com", 443)).toBe(false);
		reloadedCommand.close();
	});
});
