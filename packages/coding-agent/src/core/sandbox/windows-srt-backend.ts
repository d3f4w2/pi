import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	checkWindowsSandboxStatusAsync,
	resolveSrtWin,
	type SandboxAskCallback,
	SandboxManager,
	type SandboxRuntimeConfig,
	VENDORED_SRT_WIN_EXE,
	type WindowsBinShell,
	type WindowsSandboxStatus,
} from "@anthropic-ai/sandbox-runtime";
import { glob } from "glob";
import { buildPowerShellCommand } from "./command.ts";
import type {
	PreparedSandboxProcess,
	SandboxBackend,
	SandboxBackendContext,
	SandboxProcessRequest,
} from "./controller.ts";
import { WindowsSandboxBackend } from "./windows-backend.ts";

export interface WindowsSrtRuntime {
	initialize(config: SandboxRuntimeConfig, ask?: SandboxAskCallback, enableLogMonitor?: boolean): Promise<void>;
	wrapWithSandboxArgv(
		command: string,
		binShell?: string | WindowsBinShell,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
		cwd?: string,
	): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
	reset(): Promise<void>;
}

export interface WindowsSrtSandboxBackendOptions {
	runtime?: WindowsSrtRuntime;
	srtWinPath?: string;
	powershellPath?: string;
	controlParent?: string;
}

interface MaterializedSrtWin {
	path: string;
	digest: string;
	root: string;
	controlParent: string;
}

function runningFromBunExecutable(): boolean {
	return import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
}

function defaultSrtWinPath(): string {
	return runningFromBunExecutable()
		? path.join(path.dirname(process.execPath), "sandbox", "srt-win.exe")
		: VENDORED_SRT_WIN_EXE;
}

function defaultPowerShellPath(): string {
	return path.win32.join(
		process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
}

function defaultControlParent(): string {
	return path.win32.join(process.env.ProgramData ?? "C:\\ProgramData", "pi-sandbox");
}

async function verifySrtWin(helperPath: string, expectedDigest: string): Promise<void> {
	const digest = createHash("sha256")
		.update(await readFile(helperPath))
		.digest("hex");
	if (digest !== expectedDigest) throw new Error("Windows SRT helper integrity check failed.");
}

async function materializeSrtWin(sourcePath: string, controlParent: string): Promise<MaterializedSrtWin> {
	const source = await readFile(sourcePath);
	const digest = createHash("sha256").update(source).digest("hex");
	await mkdir(controlParent, { recursive: true });
	const root = await mkdtemp(path.join(controlParent, "session-"));
	const helperPath = path.join(root, `srt-win-${digest}.exe`);
	try {
		await writeFile(helperPath, source, { flag: "wx", mode: 0o500 });
		await verifySrtWin(helperPath, digest);
		return { path: helperPath, digest, root, controlParent };
	} catch (error) {
		await removeMaterializedSrtWin({ path: helperPath, digest, root, controlParent }).catch(() => {});
		throw error;
	}
}

async function removeMaterializedSrtWin(materialized: MaterializedSrtWin): Promise<void> {
	const parent = path.resolve(materialized.controlParent);
	const root = path.resolve(materialized.root);
	const relative = path.relative(parent, root);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Refusing to remove a Windows SRT helper outside its control directory.");
	}
	await rm(root, { recursive: true, force: true });
}

async function existingPaths(candidates: readonly string[]): Promise<string[]> {
	const present = await Promise.all(
		candidates.map(async (candidate) => {
			try {
				await access(candidate, constants.F_OK);
				return candidate;
			} catch {
				return undefined;
			}
		}),
	);
	return present.filter((candidate): candidate is string => candidate !== undefined);
}

async function protectedWorkspacePaths(workspaceRoot: string): Promise<{ read: string[]; write: string[] }> {
	const [controlPaths, environmentFiles] = await Promise.all([
		glob(["**/.git", "**/.pi"], {
			absolute: true,
			cwd: workspaceRoot,
			dot: true,
			follow: false,
			ignore: ["**/.git/**", "**/node_modules/**"],
		}),
		glob(["**/.env", "**/.env.*"], {
			absolute: true,
			cwd: workspaceRoot,
			dot: true,
			follow: false,
			ignore: ["**/.git/**", "**/node_modules/**"],
			nodir: true,
		}),
	]);
	return {
		read: [...controlPaths.filter((candidate) => path.basename(candidate) === ".pi"), ...environmentFiles],
		write: [...controlPaths, ...environmentFiles],
	};
}

export class WindowsSrtSandboxBackend implements SandboxBackend {
	readonly name = "srt-windows";
	private readonly runtime: WindowsSrtRuntime;
	private readonly sourceSrtWinPath: string;
	private readonly powershellPath: string;
	private readonly controlParent: string;
	private initialized = false;
	private materialized: MaterializedSrtWin | undefined;

	constructor(options: WindowsSrtSandboxBackendOptions = {}) {
		this.runtime = options.runtime ?? SandboxManager;
		this.sourceSrtWinPath = options.srtWinPath ?? defaultSrtWinPath();
		this.powershellPath = options.powershellPath ?? defaultPowerShellPath();
		this.controlParent = options.controlParent ?? defaultControlParent();
	}

	async initialize(context: SandboxBackendContext): Promise<void> {
		const materialized = await materializeSrtWin(this.sourceSrtWinPath, this.controlParent);
		this.materialized = materialized;
		const [credentialReadPaths, credentialWritePaths, protectedPaths] = await Promise.all([
			existingPaths(context.policy.deniedReadRoots),
			existingPaths(context.policy.deniedWriteRoots),
			protectedWorkspacePaths(context.policy.workspaceRoot),
		]);
		const config: SandboxRuntimeConfig = {
			network: {
				allowedDomains: [],
				deniedDomains: [],
				allowLocalBinding: false,
			},
			filesystem: {
				allowRead: [...context.policy.readRoots],
				allowWrite: [...context.policy.writeRoots],
				denyRead: [...credentialReadPaths, ...protectedPaths.read],
				denyWrite: [...credentialWritePaths, ...protectedPaths.write],
			},
			windows: { srtWin: { path: materialized.path } },
			allowPty: false,
		};
		const ask: SandboxAskCallback = async ({ host, port }) =>
			context.requestNetworkAccess ? context.requestNetworkAccess(host, port) : false;
		try {
			await this.runtime.initialize(config, ask, false);
			this.initialized = true;
		} catch (error) {
			await this.runtime.reset().catch(() => {});
			this.materialized = undefined;
			await removeMaterializedSrtWin(materialized).catch(() => {});
			throw error;
		}
	}

	async prepare(request: SandboxProcessRequest & { env: NodeJS.ProcessEnv }): Promise<PreparedSandboxProcess> {
		const materialized = this.materialized;
		if (!this.initialized || !materialized) throw new Error("Windows SRT sandbox backend is not initialized.");
		await verifySrtWin(materialized.path, materialized.digest);
		const command = buildPowerShellCommand(request.command, request.args, request.env);
		const prepared = await this.runtime.wrapWithSandboxArgv(
			command,
			{
				exe: this.powershellPath,
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
			},
			undefined,
			request.signal,
			request.cwd,
		);
		const [executable, ...args] = prepared.argv;
		if (!executable) throw new Error("Windows SRT sandbox returned an empty launch descriptor.");
		return { command: executable, args, cwd: request.cwd, env: prepared.env };
	}

	async reset(): Promise<void> {
		const materialized = this.materialized;
		this.initialized = false;
		this.materialized = undefined;
		try {
			if (materialized) await this.runtime.reset();
		} finally {
			if (materialized) await removeMaterializedSrtWin(materialized);
		}
	}
}

export interface WindowsAutoSandboxBackendOptions {
	status?: (srtWinPath: string) => Promise<WindowsSandboxStatus | undefined>;
	strongBackend?: SandboxBackend;
	fallbackBackend?: SandboxBackend;
	srtWinPath?: string;
}

async function defaultStatus(srtWinPath: string): Promise<WindowsSandboxStatus | undefined> {
	try {
		await access(srtWinPath, constants.F_OK);
	} catch {
		return undefined;
	}
	return checkWindowsSandboxStatusAsync({ srtWin: resolveSrtWin({ path: srtWinPath }) });
}

function hasWindowsSrtSetup(status: WindowsSandboxStatus | undefined): boolean {
	if (!status) return false;
	return (
		status.user.provisioned ||
		status.user.groupExists ||
		status.user.credPresent ||
		status.user.markerVersion !== undefined ||
		status.wfp.state === "installed"
	);
}

export class WindowsAutoSandboxBackend implements SandboxBackend {
	private readonly status: NonNullable<WindowsAutoSandboxBackendOptions["status"]>;
	private readonly strongBackend: SandboxBackend;
	private readonly fallbackBackend: SandboxBackend;
	private readonly srtWinPath: string;
	private selected: SandboxBackend | undefined;

	constructor(options: WindowsAutoSandboxBackendOptions = {}) {
		this.status = options.status ?? defaultStatus;
		this.srtWinPath = options.srtWinPath ?? defaultSrtWinPath();
		this.strongBackend = options.strongBackend ?? new WindowsSrtSandboxBackend({ srtWinPath: this.srtWinPath });
		this.fallbackBackend = options.fallbackBackend ?? new WindowsSandboxBackend();
	}

	get name(): string {
		return this.selected?.name ?? "windows-auto";
	}

	async initialize(context: SandboxBackendContext): Promise<void> {
		const status = await this.status(this.srtWinPath);
		this.selected = hasWindowsSrtSetup(status) ? this.strongBackend : this.fallbackBackend;
		await this.selected.initialize(context);
	}

	async prepare(request: SandboxProcessRequest & { env: NodeJS.ProcessEnv }): Promise<PreparedSandboxProcess> {
		if (!this.selected) throw new Error("Windows automatic sandbox backend is not initialized.");
		return this.selected.prepare(request);
	}

	async reset(): Promise<void> {
		const selected = this.selected;
		this.selected = undefined;
		if (selected) await selected.reset();
	}
}
