import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { getAgentDir } from "../../config.ts";
import {
	SandboxController,
	type SandboxControllerInitializeOptions,
	type SandboxControllerSnapshot,
} from "./controller.ts";
import { type SandboxNetworkAccessPrompt, SandboxNetworkPermissionManager } from "./network-permissions.ts";
import { checkSandboxPath, compileSandboxPolicy, type SandboxMode, type SandboxPathAccess } from "./policy.ts";

export interface DefaultSandboxRegistryOptions {
	agentDir?: string;
	controllerFactory?: () => SandboxController;
	environment?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	tempRoot?: string;
	userHome?: string;
}

interface DefaultSandboxEntry {
	controller: SandboxController;
	initialization?: Promise<SandboxController>;
	networkPermissions: SandboxNetworkPermissionManager;
	options: SandboxControllerInitializeOptions;
	policy: ReturnType<typeof compileSandboxPolicy>;
}

export function resolveDefaultSandboxMode(environment: NodeJS.ProcessEnv = process.env): SandboxMode {
	const configured = environment.PI_SANDBOX_MODE ?? "auto";
	if (configured === "auto" || configured === "read-only" || configured === "full-access") return configured;
	throw new Error(`Invalid PI_SANDBOX_MODE=${JSON.stringify(configured)}; expected auto, read-only, or full-access.`);
}

export class DefaultSandboxRegistry {
	private readonly entries = new Map<string, DefaultSandboxEntry>();
	private readonly registryOptions: DefaultSandboxRegistryOptions;

	constructor(options: DefaultSandboxRegistryOptions = {}) {
		this.registryOptions = options;
	}

	private entry(workspaceRoot: string): DefaultSandboxEntry {
		const resolvedWorkspace = path.resolve(workspaceRoot);
		const agentDir = path.resolve(this.registryOptions.agentDir ?? getAgentDir());
		const platform = this.registryOptions.platform ?? process.platform;
		const mode = resolveDefaultSandboxMode(this.registryOptions.environment ?? process.env);
		const tempRoot = path.resolve(this.registryOptions.tempRoot ?? tmpdir());
		const userHome = path.resolve(this.registryOptions.userHome ?? homedir());
		const key = JSON.stringify([mode, platform, resolvedWorkspace, agentDir, tempRoot, userHome]);
		const existing = this.entries.get(key);
		if (existing) return existing;

		const workspaceId = createHash("sha256").update(resolvedWorkspace).digest("hex").slice(0, 16);
		const sandboxTempRoot = path.join(tempRoot, "pi-sandbox", workspaceId);
		const options: SandboxControllerInitializeOptions = {
			mode,
			workspaceRoot: resolvedWorkspace,
			sandboxTempRoot,
			userHome,
			controlRoots: [agentDir],
			platform,
		};
		const networkPermissions = new SandboxNetworkPermissionManager(resolvedWorkspace, {
			storageRoot: path.join(agentDir, "network-permissions"),
		});
		const entry: DefaultSandboxEntry = {
			controller: this.registryOptions.controllerFactory?.() ?? new SandboxController(),
			networkPermissions,
			options: {
				...options,
				requestNetworkAccess: (host, port) => networkPermissions.request(host, port),
			},
			policy: mkdir(sandboxTempRoot, { recursive: true }).then(() => compileSandboxPolicy(options)),
		};
		this.entries.set(key, entry);
		return entry;
	}

	ensure(workspaceRoot: string): Promise<SandboxController> {
		const entry = this.entry(workspaceRoot);
		entry.initialization ??= entry.controller.initialize(entry.options).then(() => entry.controller);
		return entry.initialization;
	}

	async checkPath(workspaceRoot: string, candidate: string, access: SandboxPathAccess): Promise<string> {
		const decision = await checkSandboxPath(await this.entry(workspaceRoot).policy, candidate, access);
		if (!decision.allowed) throw new Error(decision.reason ?? `Sandbox denied ${access} access.`);
		return decision.canonicalPath;
	}

	async withNetworkCommand<T>(
		workspaceRoot: string,
		prompt: SandboxNetworkAccessPrompt | undefined,
		operation: (controller: SandboxController) => Promise<T>,
	): Promise<T> {
		const entry = this.entry(workspaceRoot);
		const controller = await this.ensure(workspaceRoot);
		const command = entry.networkPermissions.openCommand(prompt);
		try {
			return await operation(controller);
		} finally {
			command.close();
		}
	}

	snapshot(workspaceRoot: string): SandboxControllerSnapshot {
		return this.entry(workspaceRoot).controller.snapshot();
	}

	async reset(): Promise<void> {
		const entries = [...this.entries.values()];
		this.entries.clear();
		await Promise.all(entries.map((entry) => entry.controller.reset()));
	}
}

export const defaultSandboxRegistry = new DefaultSandboxRegistry();

export function ensureDefaultSandbox(workspaceRoot: string): Promise<SandboxController> {
	return defaultSandboxRegistry.ensure(workspaceRoot);
}

export function checkDefaultSandboxPath(
	workspaceRoot: string,
	candidate: string,
	access: SandboxPathAccess,
): Promise<string> {
	return defaultSandboxRegistry.checkPath(workspaceRoot, candidate, access);
}

export function snapshotDefaultSandbox(workspaceRoot: string): SandboxControllerSnapshot {
	return defaultSandboxRegistry.snapshot(workspaceRoot);
}

export function withDefaultSandboxNetworkCommand<T>(
	workspaceRoot: string,
	prompt: SandboxNetworkAccessPrompt | undefined,
	operation: (controller: SandboxController) => Promise<T>,
): Promise<T> {
	return defaultSandboxRegistry.withNetworkCommand(workspaceRoot, prompt, operation);
}
