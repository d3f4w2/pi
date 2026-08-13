import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { APP_NAME, getAuthPath, getModelsPath, getPackageDir, getSettingsPath, VERSION } from "../config.ts";
import {
	createDoctorReport,
	detectProjectLanguages,
	findExecutableOnPath,
	resolveDoctorShell,
} from "../extensions/doctor/checks.ts";
import { formatDoctorReport } from "../extensions/doctor/report.ts";
import type {
	DoctorFileProbes,
	DoctorFinding,
	DoctorLanguage,
	DoctorPaths,
	DoctorReport,
	DoctorSettingsError,
} from "../extensions/doctor/types.ts";

export interface CliDoctorCommandProbe {
	path: string;
	version?: string;
}

export interface CliDoctorSnapshot {
	appName: string;
	appVersion: string;
	nodeVersion: string;
	platform: NodeJS.Platform;
	arch: string;
	cwd: string;
	entryPath: string;
	packageDir: string;
	inWindowsSystemDirectory?: boolean;
	commands: Readonly<{
		git?: CliDoctorCommandProbe;
		npm?: CliDoctorCommandProbe;
		shell?: CliDoctorCommandProbe;
	}>;
	languages: readonly DoctorLanguage[];
	settingsErrors: readonly DoctorSettingsError[];
	paths: DoctorPaths;
	configFiles: Readonly<Record<"settings" | "projectSettings" | "models" | "auth", boolean>>;
}

export interface DoctorCommandDependencies {
	collectSnapshot: () => CliDoctorSnapshot;
	writeStdout: (value: string) => void;
	writeStderr: (value: string) => void;
	setExitCode: (value: number) => void;
}

const defaultFileProbes: DoctorFileProbes = {
	fileExists(candidate) {
		try {
			return statSync(candidate).isFile();
		} catch {
			return false;
		}
	},
	isExecutable(candidate) {
		try {
			accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
};

function displayPath(candidate: string): string {
	const home = homedir();
	if (!home) return candidate;
	const relative = path.relative(home, candidate);
	if (relative === "") return "~";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return candidate;
	return `~/${relative.replaceAll("\\", "/").replaceAll(path.sep, "/")}`;
}

function firstOutputLine(value: string): string | undefined {
	const line = value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.find((item) => item.length > 0);
	if (!line) return undefined;
	const characters = Array.from(line);
	return characters.length <= 200 ? line : `${characters.slice(0, 199).join("")}…`;
}

function commandVersion(commandPath: string, args: readonly string[]): string | undefined {
	try {
		const result = spawnSync(commandPath, args, {
			encoding: "utf8",
			timeout: 2_000,
			windowsHide: true,
		});
		if (result.error || result.status !== 0) return undefined;
		return firstOutputLine(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	} catch {
		return undefined;
	}
}

function commandProbe(
	command: string,
	versionArgs: readonly string[],
	pathSnapshot: { platform: NodeJS.Platform; env: Readonly<Record<string, string | undefined>> },
	probes: DoctorFileProbes,
): CliDoctorCommandProbe | undefined {
	const commandPath = findExecutableOnPath(command, pathSnapshot, probes);
	if (!commandPath) return undefined;
	const version = commandVersion(commandPath, versionArgs);
	return { path: displayPath(commandPath), ...(version === undefined ? {} : { version }) };
}

function inspectJsonFile(candidate: string, scope: DoctorSettingsError["scope"]): DoctorSettingsError | undefined {
	if (!defaultFileProbes.fileExists(candidate)) return undefined;
	try {
		JSON.parse(readFileSync(candidate, "utf8"));
		return undefined;
	} catch {
		return { scope, message: `${path.basename(candidate)} 不是有效 JSON` };
	}
}

function isWindowsSystemDirectory(cwd: string, environment: NodeJS.ProcessEnv): boolean {
	if (process.platform !== "win32") return false;
	const systemRoot = environment.SystemRoot ?? environment.WINDIR;
	if (!systemRoot) return false;
	return path.win32.resolve(cwd).toLowerCase() === path.win32.join(systemRoot, "System32").toLowerCase();
}

export function collectCliDoctorSnapshot(): CliDoctorSnapshot {
	const cwd = process.cwd();
	const environment: Readonly<Record<string, string | undefined>> = process.env;
	const pathSnapshot = { platform: process.platform, env: environment };
	const settingsPath = getSettingsPath();
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const modelsPath = getModelsPath();
	const authPath = getAuthPath();
	const settingsErrors = [
		inspectJsonFile(settingsPath, "global"),
		inspectJsonFile(projectSettingsPath, "project"),
	].filter((item): item is DoctorSettingsError => item !== undefined);
	let customShellPath: string | undefined;
	if (defaultFileProbes.fileExists(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { shellPath?: unknown };
			if (typeof parsed.shellPath === "string" && parsed.shellPath.trim()) customShellPath = parsed.shellPath;
		} catch {
			// The parse error is already represented in settingsErrors.
		}
	}
	const shell = resolveDoctorShell(
		{ ...pathSnapshot, ...(customShellPath === undefined ? {} : { customShellPath }) },
		defaultFileProbes,
	);
	const shellVersion = shell === undefined ? undefined : commandVersion(shell.path, ["--version"]);
	const shellProbe =
		shell === undefined
			? undefined
			: {
					path: displayPath(shell.path),
					...(shellVersion === undefined ? {} : { version: shellVersion }),
				};
	const paths = {
		settings: displayPath(settingsPath),
		projectSettings: displayPath(projectSettingsPath),
		models: displayPath(modelsPath),
		auth: displayPath(authPath),
	};
	return {
		appName: APP_NAME,
		appVersion: VERSION,
		nodeVersion: process.version,
		platform: process.platform,
		arch: process.arch,
		cwd: displayPath(cwd),
		entryPath: displayPath(process.argv[1] ?? ""),
		packageDir: displayPath(getPackageDir()),
		...(isWindowsSystemDirectory(cwd, process.env) ? { inWindowsSystemDirectory: true } : {}),
		commands: {
			git: commandProbe("git", ["--version"], pathSnapshot, defaultFileProbes),
			npm: commandProbe("npm", ["--version"], pathSnapshot, defaultFileProbes),
			...(shellProbe === undefined ? {} : { shell: shellProbe }),
		},
		languages: detectProjectLanguages({ platform: process.platform, cwd }, defaultFileProbes),
		settingsErrors,
		paths,
		configFiles: {
			settings: defaultFileProbes.fileExists(settingsPath),
			projectSettings: defaultFileProbes.fileExists(projectSettingsPath),
			models: defaultFileProbes.fileExists(modelsPath),
			auth: defaultFileProbes.fileExists(authPath),
		},
	};
}

function probeDetail(probe: CliDoctorCommandProbe): string {
	return probe.version ? `${probe.version}；${probe.path}` : probe.path;
}

export function runCliDoctorChecks(snapshot: CliDoctorSnapshot): DoctorReport {
	const findings: DoctorFinding[] = [
		{
			id: "runtime",
			area: "core",
			severity: "ok",
			label: "运行时",
			detail: `${snapshot.appName} ${snapshot.appVersion}；Node ${snapshot.nodeVersion}；${snapshot.platform}/${snapshot.arch}`,
		},
		{
			id: "installation",
			area: "core",
			severity: snapshot.entryPath ? "ok" : "warning",
			label: "安装入口",
			detail: snapshot.entryPath
				? `${snapshot.entryPath}；包目录 ${snapshot.packageDir}`
				: "无法确定 CLI 入口路径。",
			...(snapshot.entryPath ? {} : { fix: "重新安装 Pigo，并确认全局 npm bin 已加入 PATH。" }),
		},
		{
			id: "cwd",
			area: "core",
			severity: snapshot.inWindowsSystemDirectory ? "warning" : "ok",
			label: "当前工作目录",
			detail: snapshot.inWindowsSystemDirectory
				? `${snapshot.cwd} 是 Windows 系统目录，不应作为代码项目运行。`
				: `${snapshot.cwd}${snapshot.languages.length > 0 ? `；检测到 ${snapshot.languages.join("、")}` : "；未检测到常见项目根标记"}`,
			...(snapshot.inWindowsSystemDirectory ? { fix: "先 cd 到项目目录，再运行 pigo。" } : {}),
		},
	];

	if (snapshot.commands.git) {
		findings.push({
			id: "git",
			area: "core",
			severity: "ok",
			label: "Git",
			detail: probeDetail(snapshot.commands.git),
		});
	} else {
		findings.push({
			id: "git",
			area: "core",
			severity: "error",
			label: "Git",
			detail: "没有找到 Git。",
			fix: "安装 Git，并把 git 可执行文件加入 PATH。",
		});
	}

	if (snapshot.commands.npm) {
		findings.push({
			id: "npm",
			area: "core",
			severity: "ok",
			label: "npm",
			detail: probeDetail(snapshot.commands.npm),
		});
	} else {
		findings.push({
			id: "npm",
			area: "core",
			severity: "warning",
			label: "npm",
			detail: "没有找到 npm；当前 Pigo 可以继续运行，但无法通过 npm 更新。",
			fix: "安装包含 npm 的 Node.js，或使用未来提供的独立二进制更新方式。",
		});
	}

	if (snapshot.commands.shell) {
		findings.push({
			id: "shell",
			area: "shell",
			severity: "ok",
			label: snapshot.platform === "win32" ? "Git Bash" : "Bash",
			detail: probeDetail(snapshot.commands.shell),
		});
	} else {
		findings.push({
			id: "shell",
			area: "shell",
			severity: "warning",
			label: snapshot.platform === "win32" ? "Git Bash" : "Bash",
			detail: "没有找到可用 Bash。",
			fix:
				snapshot.platform === "win32"
					? "安装 Git for Windows，或在 settings.json 设置 shellPath。"
					: "安装 bash，并确认它位于 PATH。",
		});
	}

	if (snapshot.settingsErrors.length > 0) {
		findings.push({
			id: "settings",
			area: "config",
			severity: "error",
			label: "设置文件",
			detail: snapshot.settingsErrors.map((error) => `${error.scope}: ${error.message}`).join("；"),
			fix: "修正对应 settings.json 的 JSON 格式。",
		});
	} else {
		findings.push({
			id: "settings",
			area: "config",
			severity: "ok",
			label: "设置文件",
			detail:
				snapshot.configFiles.settings || snapshot.configFiles.projectSettings
					? "已找到且能够解析 settings.json。"
					: "未创建 settings.json，当前使用默认设置。",
		});
	}

	findings.push({
		id: "model-config",
		area: "config",
		severity: snapshot.configFiles.models ? "ok" : "info",
		label: "模型配置",
		detail: snapshot.configFiles.models ? "models.json 存在。" : "models.json 不存在；可使用内置模型目录。",
	});
	findings.push({
		id: "auth-file",
		area: "config",
		severity: snapshot.configFiles.auth ? "ok" : "info",
		label: "认证文件",
		detail: snapshot.configFiles.auth ? "auth.json 存在；未读取凭据内容。" : "auth.json 不存在。",
		...(snapshot.configFiles.auth ? {} : { fix: "需要认证时在 Pigo 中使用 /login。" }),
	});

	return createDoctorReport(findings);
}

function productTitle(appName: string): string {
	return appName.length === 0 ? "Pigo" : `${appName[0]?.toUpperCase() ?? ""}${appName.slice(1)}`;
}

function doctorHelp(appName: string): string {
	return `${productTitle(appName)} 离线健康检查

用法:
  ${appName} doctor [--json]

选项:
  --json       输出机器可读 JSON
  --help, -h   显示此帮助

检查安装、Node、Git、npm、Shell、当前目录和配置文件；不会连接模型服务，也不会读取凭据内容。`;
}

function conciseUnexpectedError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const cleaned = message
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [已隐藏]")
		.replace(/\bsk-[a-z0-9_-]{8,}/gi, "[已隐藏]")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(cleaned);
	return characters.length <= 300 ? cleaned : `${characters.slice(0, 299).join("")}…`;
}

const defaultDependencies: DoctorCommandDependencies = {
	collectSnapshot: collectCliDoctorSnapshot,
	writeStdout: (value) => console.log(value),
	writeStderr: (value) => console.error(value),
	setExitCode: (value) => {
		process.exitCode = value;
	},
};

export function runDoctorCommand(
	args: readonly string[],
	dependencies: DoctorCommandDependencies = defaultDependencies,
): number {
	const unknown = args.find((arg) => arg !== "--json" && arg !== "--help" && arg !== "-h");
	if (unknown !== undefined) {
		dependencies.writeStderr(`未知选项 "${unknown}"。使用 "${APP_NAME} doctor --help" 查看用法。`);
		dependencies.setExitCode(2);
		return 2;
	}
	if (args.includes("--help") || args.includes("-h")) {
		dependencies.writeStdout(doctorHelp(APP_NAME));
		dependencies.setExitCode(0);
		return 0;
	}

	try {
		const snapshot = dependencies.collectSnapshot();
		const report = runCliDoctorChecks(snapshot);
		if (args.includes("--json")) {
			dependencies.writeStdout(
				JSON.stringify(
					{
						version: 1,
						product: { name: snapshot.appName, version: snapshot.appVersion },
						runtime: {
							node: snapshot.nodeVersion,
							platform: snapshot.platform,
							arch: snapshot.arch,
							cwd: snapshot.cwd,
						},
						paths: snapshot.paths,
						report,
					},
					null,
					2,
				),
			);
		} else {
			dependencies.writeStdout(formatDoctorReport(report, snapshot.paths, productTitle(snapshot.appName)));
		}
		const exitCode = report.summary.error > 0 ? 1 : 0;
		dependencies.setExitCode(exitCode);
		return exitCode;
	} catch (error) {
		dependencies.writeStderr(`健康检查失败：${conciseUnexpectedError(error)}`);
		dependencies.setExitCode(1);
		return 1;
	}
}
