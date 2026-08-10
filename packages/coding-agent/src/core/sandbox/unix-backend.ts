import { type SandboxAskCallback, SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { buildPosixCommand } from "./command.ts";
import type {
	PreparedSandboxProcess,
	SandboxBackend,
	SandboxBackendContext,
	SandboxProcessRequest,
} from "./controller.ts";

export interface UnixSandboxRuntime {
	initialize(config: SandboxRuntimeConfig, ask?: SandboxAskCallback, enableLogMonitor?: boolean): Promise<void>;
	wrapWithSandbox(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
	): Promise<string>;
	reset(): Promise<void>;
}

export class UnixSandboxBackend implements SandboxBackend {
	readonly name = process.platform === "darwin" ? "seatbelt" : "bubblewrap";
	private readonly runtime: UnixSandboxRuntime;
	private initialized = false;

	constructor(runtime: UnixSandboxRuntime = SandboxManager) {
		this.runtime = runtime;
	}

	async initialize(context: SandboxBackendContext): Promise<void> {
		const workspace = context.policy.workspaceRoot.replaceAll("\\", "/");
		const protectedReadPaths = [
			`${workspace}/.pi`,
			`${workspace}/**/.pi`,
			`${workspace}/**/.pi/**`,
			`${workspace}/.env`,
			`${workspace}/.env.*`,
			`${workspace}/**/.env`,
			`${workspace}/**/.env.*`,
		];
		const protectedWritePaths = [
			`${workspace}/.git`,
			`${workspace}/**/.git`,
			`${workspace}/**/.git/**`,
			...protectedReadPaths,
		];
		const config: SandboxRuntimeConfig = {
			network: {
				allowedDomains: [],
				deniedDomains: [],
				allowLocalBinding: false,
				allowUnixSockets: [],
			},
			filesystem: {
				denyRead: [...context.policy.deniedReadRoots, ...protectedReadPaths],
				allowWrite: [...context.policy.writeRoots],
				denyWrite: [...context.policy.deniedWriteRoots, ...protectedWritePaths],
			},
			mandatoryDenySearchDepth: 10,
			allowPty: false,
		};
		const ask: SandboxAskCallback = async ({ host, port }) =>
			context.requestNetworkAccess ? context.requestNetworkAccess(host, port) : false;
		await this.runtime.initialize(config, ask, process.platform === "darwin");
		this.initialized = true;
	}

	async prepare(request: SandboxProcessRequest & { env: NodeJS.ProcessEnv }): Promise<PreparedSandboxProcess> {
		if (!this.initialized) throw new Error("Unix sandbox backend is not initialized.");
		const command = buildPosixCommand(request.command, request.args);
		const wrapped = await this.runtime.wrapWithSandbox(command, "/bin/bash", undefined, request.signal);
		return { command: "/bin/bash", args: ["-c", wrapped], cwd: request.cwd, env: request.env };
	}

	async reset(): Promise<void> {
		if (!this.initialized) return;
		this.initialized = false;
		await this.runtime.reset();
	}
}
