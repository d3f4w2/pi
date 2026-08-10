import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { glob } from "glob";
import { encodeSandboxLaunchRequest } from "./command.ts";
import type {
	PreparedSandboxProcess,
	SandboxBackend,
	SandboxBackendContext,
	SandboxProcessRequest,
} from "./controller.ts";

const execFileAsync = promisify(execFile);

export interface WindowsSandboxBackendOptions {
	scriptPath?: string;
	powershellPath?: string;
	controlRoot?: string;
	probe?: (powershellPath: string, scriptPath: string) => Promise<void>;
	resolveExecutable?: (command: string, environment: NodeJS.ProcessEnv) => Promise<string>;
}

async function fileExists(candidate: string): Promise<boolean> {
	try {
		await access(candidate, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolveWindowsExecutable(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
	if (command.includes("\0")) throw new Error("Sandbox command contains a NUL byte.");
	if (path.win32.isAbsolute(command)) {
		if (await fileExists(command)) return path.win32.resolve(command);
		throw new Error(`Sandbox executable does not exist: ${command}`);
	}
	if (command.includes("/") || command.includes("\\")) {
		const candidate = path.win32.resolve(command);
		if (await fileExists(candidate)) return candidate;
		throw new Error(`Sandbox executable does not exist: ${command}`);
	}
	const executableExtensions = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.filter(Boolean)
		.map((extension) => extension.toLowerCase());
	const hasKnownExtension = executableExtensions.includes(path.win32.extname(command).toLowerCase());
	const names = hasKnownExtension
		? [command]
		: [command, ...executableExtensions.map((extension) => `${command}${extension}`)];
	for (const directory of (environment.PATH ?? environment.Path ?? "").split(";")) {
		if (!directory) continue;
		for (const name of names) {
			const candidate = path.win32.join(directory, name);
			if (await fileExists(candidate)) return candidate;
		}
	}
	throw new Error(`Sandbox executable was not found on PATH: ${command}`);
}

async function probeWindowsLauncher(powershellPath: string, scriptPath: string): Promise<void> {
	await execFileAsync(
		powershellPath,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Probe"],
		{ timeout: 15_000, windowsHide: true },
	);
}

function defaultScriptPath(): string {
	if (import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN")) {
		return path.join(path.dirname(process.execPath), "sandbox", "pi-sandbox.ps1");
	}
	return fileURLToPath(new URL("./windows/pi-sandbox.ps1", import.meta.url));
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

interface MaterializedLauncher {
	path: string;
	digest: string;
}

async function verifyLauncher(launcherPath: string, expectedDigest: string): Promise<void> {
	const materialized = await readFile(launcherPath);
	const materializedDigest = createHash("sha256").update(materialized).digest("hex");
	if (materializedDigest !== expectedDigest) throw new Error("Windows sandbox launcher integrity check failed.");
}

async function materializeLauncher(sourcePath: string, controlRoot: string): Promise<MaterializedLauncher> {
	const source = await readFile(sourcePath);
	const digest = createHash("sha256").update(source).digest("hex");
	const launcherDirectory = path.join(controlRoot, "launchers");
	const launcherPath = path.join(launcherDirectory, `${digest}.ps1`);
	await mkdir(launcherDirectory, { recursive: true, mode: 0o700 });
	try {
		await writeFile(launcherPath, source, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	await verifyLauncher(launcherPath, digest);
	return { path: launcherPath, digest };
}

async function findProtectedEnvironmentFiles(workspaceRoot: string): Promise<string[]> {
	return glob(["**/.env", "**/.env.*"], {
		absolute: true,
		cwd: workspaceRoot,
		dot: true,
		follow: false,
		ignore: ["**/.git/**", "**/node_modules/**"],
		nodir: true,
	});
}

export class WindowsSandboxBackend implements SandboxBackend {
	readonly name = "restricted-token";
	private readonly sourceScriptPath: string;
	private readonly powershellPath: string;
	private readonly controlRoot: string;
	private readonly probe: NonNullable<WindowsSandboxBackendOptions["probe"]>;
	private readonly resolveExecutable: NonNullable<WindowsSandboxBackendOptions["resolveExecutable"]>;
	private context: SandboxBackendContext | undefined;
	private launcherPath: string | undefined;
	private launcherDigest: string | undefined;
	private protectedEnvironmentFiles: readonly string[] = [];

	constructor(options: WindowsSandboxBackendOptions = {}) {
		this.sourceScriptPath = options.scriptPath ?? defaultScriptPath();
		this.powershellPath = options.powershellPath ?? defaultPowerShellPath();
		this.controlRoot = options.controlRoot ?? path.join(tmpdir(), "pi-sandbox-control", String(process.pid));
		this.probe = options.probe ?? probeWindowsLauncher;
		this.resolveExecutable = options.resolveExecutable ?? resolveWindowsExecutable;
	}

	async initialize(context: SandboxBackendContext): Promise<void> {
		if (!(await fileExists(this.sourceScriptPath)))
			throw new Error(`Windows sandbox launcher is missing: ${this.sourceScriptPath}`);
		const launcher = await materializeLauncher(this.sourceScriptPath, this.controlRoot);
		await this.probe(this.powershellPath, launcher.path);
		this.launcherPath = launcher.path;
		this.launcherDigest = launcher.digest;
		this.protectedEnvironmentFiles = await findProtectedEnvironmentFiles(context.policy.workspaceRoot);
		this.context = context;
	}

	async prepare(request: SandboxProcessRequest & { env: NodeJS.ProcessEnv }): Promise<PreparedSandboxProcess> {
		const context = this.context;
		const launcherPath = this.launcherPath;
		const launcherDigest = this.launcherDigest;
		if (!context || !launcherPath || !launcherDigest) throw new Error("Windows sandbox backend is not initialized.");
		await verifyLauncher(launcherPath, launcherDigest);
		const executable = await this.resolveExecutable(request.command, request.env);
		const workspace = context.policy.workspaceRoot;
		const encoded = encodeSandboxLaunchRequest({
			version: 1,
			command: executable,
			args: [...request.args],
			cwd: request.cwd,
			workspaceRoot: workspace,
			tempRoot: context.policy.sandboxTempRoot,
			readOnly: context.policy.mode === "read-only",
			protectedWritePaths: [
				path.win32.join(workspace, ".git"),
				path.win32.join(workspace, ".pi"),
				path.win32.join(workspace, ".env"),
				...this.protectedEnvironmentFiles,
			],
		});
		return {
			command: this.powershellPath,
			args: [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				launcherPath,
				"-Request",
				encoded,
			],
			cwd: request.cwd,
			env: request.env,
		};
	}

	async reset(): Promise<void> {
		this.context = undefined;
		this.launcherPath = undefined;
		this.launcherDigest = undefined;
		this.protectedEnvironmentFiles = [];
	}
}
