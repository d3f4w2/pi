import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SandboxProxyEnvironment } from "./environment.ts";
import { createSandboxEnvironment } from "./environment.ts";
import { checkSandboxPath, compileSandboxPolicy, type SandboxMode, type SandboxPolicy } from "./policy.ts";

export type SandboxControllerState = "uninitialized" | "initializing" | "active" | "failed";

export interface SandboxProcessRequest {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export interface PreparedSandboxProcess {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface SandboxBackendContext {
	policy: SandboxPolicy;
	proxy?: SandboxProxyEnvironment;
	requestNetworkAccess?: (host: string, port: number | undefined) => Promise<boolean>;
}

export interface SandboxBackend {
	readonly name: string;
	initialize(context: SandboxBackendContext): Promise<void>;
	prepare(request: SandboxProcessRequest & { env: NodeJS.ProcessEnv }): Promise<PreparedSandboxProcess>;
	reset(): Promise<void>;
}

export interface SandboxControllerInitializeOptions {
	mode: SandboxMode;
	workspaceRoot: string;
	sandboxTempRoot: string;
	userHome: string;
	controlRoots?: readonly string[];
	platform?: NodeJS.Platform;
	proxy?: SandboxProxyEnvironment;
	requestNetworkAccess?: (host: string, port: number | undefined) => Promise<boolean>;
}

export interface SandboxControllerSnapshot {
	state: SandboxControllerState;
	mode?: SandboxMode;
	backend?: string;
	workspaceRoot?: string;
	enforced: boolean;
	error?: string;
}

export type SandboxBackendFactory = (platform: NodeJS.Platform) => SandboxBackend | Promise<SandboxBackend>;

function unavailableBackend(platform: NodeJS.Platform): SandboxBackend {
	return {
		name: `${platform}-unavailable`,
		async initialize() {
			throw new Error(`No OS sandbox backend is available for ${platform}.`);
		},
		async prepare() {
			throw new Error(`No OS sandbox backend is available for ${platform}.`);
		},
		async reset() {},
	};
}

async function defaultBackendFactory(platform: NodeJS.Platform): Promise<SandboxBackend> {
	if (platform === "linux" || platform === "darwin") {
		const { UnixSandboxBackend } = await import("./unix-backend.ts");
		return new UnixSandboxBackend();
	}
	if (platform === "win32") {
		const { WindowsAutoSandboxBackend } = await import("./windows-srt-backend.ts");
		return new WindowsAutoSandboxBackend();
	}
	return unavailableBackend(platform);
}

export class SandboxController {
	private readonly backendFactory: SandboxBackendFactory;
	private state: SandboxControllerState = "uninitialized";
	private mode: SandboxMode | undefined;
	private backend: SandboxBackend | undefined;
	private policy: SandboxPolicy | undefined;
	private proxy: SandboxProxyEnvironment | undefined;
	private error: Error | undefined;
	private initialization: Promise<void> | undefined;
	private configurationKey: string | undefined;

	constructor(backendFactory: SandboxBackendFactory = defaultBackendFactory) {
		this.backendFactory = backendFactory;
	}

	initialize(options: SandboxControllerInitializeOptions): Promise<void> {
		if (this.state === "failed") {
			return Promise.reject(new Error(`Sandbox unavailable: ${this.error?.message ?? "initialization failed"}`));
		}
		const configurationKey = JSON.stringify([
			options.mode,
			options.platform ?? process.platform,
			path.resolve(options.workspaceRoot),
			path.resolve(options.sandboxTempRoot),
			...(options.controlRoots ?? []).map((root) => path.resolve(root)).sort(),
		]);
		if (this.initialization) {
			return this.configurationKey === configurationKey
				? this.initialization
				: Promise.reject(new Error("Sandbox initialization is already in progress for a different configuration."));
		}
		if (this.state === "active") {
			if (this.configurationKey === configurationKey) return Promise.resolve();
			return Promise.reject(new Error("Sandbox is already initialized with a different configuration."));
		}

		this.state = "initializing";
		this.mode = options.mode;
		this.error = undefined;
		this.proxy = options.proxy;
		this.configurationKey = configurationKey;
		this.initialization = this.initializeOnce(options).finally(() => {
			this.initialization = undefined;
		});
		return this.initialization;
	}

	private async initializeOnce(options: SandboxControllerInitializeOptions): Promise<void> {
		try {
			await Promise.all(
				["home", "tmp", "cache", "config", "npm-cache"].map((directory) =>
					mkdir(path.join(options.sandboxTempRoot, directory), { recursive: true }),
				),
			);
			this.policy = await compileSandboxPolicy(options);
			if (options.mode === "full-access") {
				this.backend = undefined;
				this.state = "active";
				return;
			}
			const backend = await this.backendFactory(options.platform ?? process.platform);
			this.backend = backend;
			await backend.initialize({
				policy: this.policy,
				...(options.proxy ? { proxy: options.proxy } : {}),
				...(options.requestNetworkAccess ? { requestNetworkAccess: options.requestNetworkAccess } : {}),
			});
			this.state = "active";
		} catch (error) {
			this.error = error instanceof Error ? error : new Error(String(error));
			this.state = "failed";
			throw this.error;
		}
	}

	async prepare(request: SandboxProcessRequest): Promise<PreparedSandboxProcess> {
		if (this.state === "failed") {
			throw new Error(`Sandbox unavailable: ${this.error?.message ?? "initialization failed"}`);
		}
		if (this.state !== "active" || !this.mode || !this.policy) {
			throw new Error("Sandbox is not initialized; refusing host process execution.");
		}
		if (this.mode === "full-access") {
			return {
				command: request.command,
				args: [...request.args],
				cwd: request.cwd,
				env: request.env ?? process.env,
			};
		}
		const cwdDecision = await checkSandboxPath(this.policy, request.cwd, "read");
		if (!cwdDecision.allowed) throw new Error(cwdDecision.reason ?? "Sandbox denied the working directory.");
		if (!this.backend) throw new Error("Sandbox backend is unavailable; refusing host process execution.");
		const environment = createSandboxEnvironment(request.env ?? process.env, {
			tempRoot: this.policy.sandboxTempRoot,
			platform: this.policy.platform,
			...(this.proxy ? { proxy: this.proxy } : {}),
		});
		return this.backend.prepare({
			...request,
			args: [...request.args],
			cwd: cwdDecision.canonicalPath,
			env: environment,
		});
	}

	async checkPath(candidate: string, access: "read" | "write"): Promise<string> {
		if (this.state === "failed") {
			throw new Error(`Sandbox unavailable: ${this.error?.message ?? "initialization failed"}`);
		}
		if (this.state !== "active" || !this.policy) {
			throw new Error("Sandbox is not initialized; refusing host file access.");
		}
		const decision = await checkSandboxPath(this.policy, candidate, access);
		if (!decision.allowed) throw new Error(decision.reason ?? `Sandbox denied ${access} access.`);
		return decision.canonicalPath;
	}

	async reset(): Promise<void> {
		const backend = this.backend;
		this.backend = undefined;
		this.policy = undefined;
		this.mode = undefined;
		this.proxy = undefined;
		this.error = undefined;
		this.configurationKey = undefined;
		this.state = "uninitialized";
		if (backend) await backend.reset();
	}

	snapshot(): SandboxControllerSnapshot {
		return {
			state: this.state,
			...(this.mode ? { mode: this.mode } : {}),
			...(this.mode === "full-access" ? { backend: "host" } : this.backend ? { backend: this.backend.name } : {}),
			...(this.policy ? { workspaceRoot: this.policy.workspaceRoot } : {}),
			enforced: this.state === "active" && this.mode !== "full-access",
			...(this.error ? { error: this.error.message } : {}),
		};
	}
}

export const sandboxController = new SandboxController();
