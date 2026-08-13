import path from "node:path";
import { selectUsableWindowsBashPath } from "../../utils/shell.ts";
import type {
	DoctorFileProbes,
	DoctorFinding,
	DoctorLanguage,
	DoctorReport,
	DoctorSeverity,
	DoctorSnapshot,
} from "./types.ts";

const PROJECT_MARKERS: Readonly<Record<DoctorLanguage, readonly string[]>> = {
	typescript: ["tsconfig.json", "jsconfig.json", "package.json"],
	python: ["pyproject.toml", "uv.lock", "requirements.txt", "setup.cfg", "setup.py"],
	go: ["go.work", "go.mod"],
};

const CORE_TOOLS = ["read", "bash", "edit", "write", "grep"] as const;
const SEVERITY_WEIGHT: Readonly<Record<DoctorSeverity, number>> = { ok: 0, info: 1, warning: 2, error: 3 };

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
	return platform === "win32" ? path.win32 : path.posix;
}

function environmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
	const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : environment[key];
}

type DoctorPathSnapshot = Pick<DoctorSnapshot, "platform" | "env">;
type DoctorShellSnapshot = Pick<DoctorSnapshot, "platform" | "env" | "customShellPath">;
type DoctorProjectSnapshot = Pick<DoctorSnapshot, "platform" | "cwd">;

function pathEntries(snapshot: DoctorPathSnapshot): string[] {
	const delimiter = snapshot.platform === "win32" ? ";" : ":";
	return (environmentValue(snapshot.env, "PATH") ?? "")
		.split(delimiter)
		.map((entry) => entry.trim().replace(/^"|"$/g, ""))
		.filter((entry) => entry.length > 0 && entry.length <= 4096)
		.slice(0, 256);
}

function windowsExecutableNames(command: string, snapshot: DoctorPathSnapshot): string[] {
	if (path.win32.extname(command)) return [command];
	const extensions = (environmentValue(snapshot.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((extension) => extension.trim())
		.filter(Boolean)
		.slice(0, 32)
		.map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
	return extensions.map((extension) => `${command}${extension}`);
}

export function findExecutableOnPath(
	command: string,
	snapshot: DoctorPathSnapshot,
	probes: DoctorFileProbes,
): string | undefined {
	const paths = pathApi(snapshot.platform);
	const hasPathSeparator = command.includes("/") || command.includes("\\");
	const names = snapshot.platform === "win32" ? windowsExecutableNames(command, snapshot) : [command];
	const directories = hasPathSeparator ? [""] : pathEntries(snapshot);
	for (const directory of directories) {
		for (const name of names) {
			const candidate = directory ? paths.join(directory, name) : name;
			try {
				if (probes.fileExists(candidate) && probes.isExecutable(candidate)) return candidate;
			} catch {
				// One inaccessible PATH entry must not hide later usable entries.
			}
		}
	}
	return undefined;
}

export interface DoctorShellResolution {
	path: string;
	source: "settings" | "known" | "path";
}

export function resolveDoctorShell(
	snapshot: DoctorShellSnapshot,
	probes: DoctorFileProbes,
): DoctorShellResolution | undefined {
	if (snapshot.customShellPath) {
		try {
			const selected =
				snapshot.platform === "win32"
					? selectUsableWindowsBashPath([snapshot.customShellPath], probes.fileExists)
					: probes.fileExists(snapshot.customShellPath)
						? snapshot.customShellPath
						: null;
			if (selected && probes.isExecutable(selected)) return { path: selected, source: "settings" };
		} catch {
			return undefined;
		}
		return undefined;
	}

	if (snapshot.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = environmentValue(snapshot.env, "ProgramFiles");
		if (programFiles) candidates.push(path.win32.join(programFiles, "Git", "bin", "bash.exe"));
		const programFilesX86 = environmentValue(snapshot.env, "ProgramFiles(x86)");
		if (programFilesX86) candidates.push(path.win32.join(programFilesX86, "Git", "bin", "bash.exe"));
		for (const directory of pathEntries(snapshot)) {
			candidates.push(path.win32.join(directory, "bash.exe"));
			if (path.win32.basename(directory).toLowerCase() === "cmd") {
				candidates.push(path.win32.join(path.win32.dirname(directory), "bin", "bash.exe"));
			}
		}
		try {
			const selected = selectUsableWindowsBashPath(candidates, probes.fileExists);
			if (selected && probes.isExecutable(selected)) {
				return { path: selected, source: candidates.indexOf(selected) < 2 ? "known" : "path" };
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	try {
		if (probes.fileExists("/bin/bash") && probes.isExecutable("/bin/bash")) {
			return { path: "/bin/bash", source: "known" };
		}
	} catch {
		// Continue with PATH resolution.
	}
	const shell = findExecutableOnPath("bash", snapshot, probes);
	return shell === undefined ? undefined : { path: shell, source: "path" };
}

export function detectProjectLanguages(snapshot: DoctorProjectSnapshot, probes: DoctorFileProbes): DoctorLanguage[] {
	const paths = pathApi(snapshot.platform);
	const detected: DoctorLanguage[] = [];
	for (const language of ["typescript", "python", "go"] as const) {
		let found = false;
		for (const marker of PROJECT_MARKERS[language]) {
			try {
				if (probes.fileExists(paths.join(snapshot.cwd, marker))) found = true;
			} catch {
				// An inaccessible marker is equivalent to missing for this bounded probe.
			}
		}
		if (found) detected.push(language);
	}
	return detected;
}

function sensitiveEnvironmentValues(snapshot: DoctorSnapshot): string[] {
	return Object.entries(snapshot.env)
		.filter(([name, value]) => /(?:key|token|secret|password|credential)/i.test(name) && (value?.length ?? 0) >= 4)
		.map(([, value]) => value as string)
		.sort((left, right) => right.length - left.length);
}

function sanitize(value: string, snapshot: DoctorSnapshot): string {
	let result = value;
	for (const secret of sensitiveEnvironmentValues(snapshot)) result = result.split(secret).join("[已隐藏]");
	result = result
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [已隐藏]")
		.replace(/\bsk-[a-z0-9_-]{8,}/gi, "[已隐藏]")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(result);
	return characters.length <= 400 ? result : `${characters.slice(0, 399).join("")}…`;
}

function finding(snapshot: DoctorSnapshot, value: Omit<DoctorFinding, "detail"> & { detail: string }): DoctorFinding {
	return {
		...value,
		detail: sanitize(value.detail, snapshot),
		...(value.fix === undefined ? {} : { fix: sanitize(value.fix, snapshot) }),
	};
}

export function createDoctorReport(findings: DoctorFinding[]): DoctorReport {
	const summary = {
		ok: findings.filter((item) => item.severity === "ok").length,
		info: findings.filter((item) => item.severity === "info").length,
		warning: findings.filter((item) => item.severity === "warning").length,
		error: findings.filter((item) => item.severity === "error").length,
	};
	const severity = findings.reduce<DoctorSeverity>(
		(highest, item) => (SEVERITY_WEIGHT[item.severity] > SEVERITY_WEIGHT[highest] ? item.severity : highest),
		"ok",
	);
	return {
		findings: [...findings].sort(
			(left, right) =>
				SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity] || left.id.localeCompare(right.id),
		),
		summary,
		severity,
	};
}

export function runDoctorChecks(snapshot: DoctorSnapshot, probes: DoctorFileProbes): DoctorReport {
	const findings: DoctorFinding[] = [];
	const add = (value: Omit<DoctorFinding, "detail"> & { detail: string }): void => {
		findings.push(finding(snapshot, value));
	};

	if (snapshot.modelError) {
		add({
			id: "models",
			area: "core",
			severity: "error",
			label: "模型配置",
			detail: snapshot.modelError,
			fix: `修正 ${snapshot.paths.models}，或输入 /api 重新保存供应商配置。`,
		});
	} else if (snapshot.availableModelCount === 0) {
		add({
			id: "models",
			area: "core",
			severity: "error",
			label: "可用模型",
			detail: "当前没有可用模型。",
			fix: "输入 /api 添加供应商和模型，或用 /login 登录内置供应商。",
		});
	} else {
		add({
			id: "models",
			area: "core",
			severity: "ok",
			label: "可用模型",
			detail: `已加载 ${snapshot.availableModelCount} 个可用模型。`,
		});
	}

	if (snapshot.currentModel) {
		add({
			id: "current-model",
			area: "core",
			severity: "ok",
			label: "当前模型",
			detail: `${snapshot.currentModel.provider}/${snapshot.currentModel.id}`,
		});
		add({
			id: "model-auth",
			area: "core",
			severity: snapshot.currentModel.hasConfiguredAuth ? "ok" : "info",
			label: "模型认证",
			detail: snapshot.currentModel.hasConfiguredAuth
				? "已发现认证配置；未读取凭据内容。"
				: "未发现已配置认证；无需 Key 的本地服务可以忽略。",
			...(snapshot.currentModel.hasConfiguredAuth ? {} : { fix: "需要认证时使用 /api 或 /login。" }),
		});
	} else if (snapshot.availableModelCount > 0) {
		add({
			id: "current-model",
			area: "core",
			severity: "warning",
			label: "当前模型",
			detail: "已有可用模型，但当前没有选中模型。",
			fix: "输入 /model 选择模型。",
		});
	}

	const registered = new Set(snapshot.registeredTools);
	const missingCoreTools = CORE_TOOLS.filter((tool) => !registered.has(tool));
	add({
		id: "core-tools",
		area: "core",
		severity: missingCoreTools.length === 0 ? "ok" : "error",
		label: "核心工具",
		detail:
			missingCoreTools.length === 0
				? `read、bash、edit、write、grep 均已注册；当前活动 ${snapshot.activeTools.length}/${snapshot.registeredTools.length} 个工具。`
				: `缺少核心工具：${missingCoreTools.join("、")}。`,
		...(missingCoreTools.length === 0 ? {} : { fix: "输入 /reload；仍缺失时检查内置扩展加载错误。" }),
	});

	if (snapshot.sandbox) {
		const sandbox = snapshot.sandbox;
		if (sandbox.state === "failed") {
			add({
				id: "sandbox",
				area: "sandbox",
				severity: "error",
				label: "安全沙箱",
				detail: sandbox.error ?? "沙箱初始化失败。",
				fix: "修复后重启 Pi；不要用 full-access 绕过未知的初始化错误。",
			});
		} else if (sandbox.state !== "active") {
			add({
				id: "sandbox",
				area: "sandbox",
				severity: "info",
				label: "安全沙箱",
				detail: "尚未初始化；第一次使用内置文件或进程工具时会自动启动。",
			});
		} else if (sandbox.backend === "host") {
			add({
				id: "sandbox",
				area: "sandbox",
				severity: "warning",
				label: "安全沙箱",
				detail: "当前为 full-access，内置工具直接在宿主机执行。",
				fix: "删除 PI_SANDBOX_MODE=full-access 并重启 Pi。",
			});
		} else if (sandbox.backend === "restricted-token") {
			add({
				id: "sandbox",
				area: "sandbox",
				severity: "warning",
				label: "安全沙箱",
				detail: "Windows restricted-token 已限制写入和进程树，但仍保留宿主读取和直接联网能力。",
				fix: "运行一次 Windows 独立账户沙箱安装命令，然后重启 Pi。",
			});
		} else {
			add({
				id: "sandbox",
				area: "sandbox",
				severity: sandbox.enforced ? "ok" : "warning",
				label: "安全沙箱",
				detail: `后端 ${sandbox.backend ?? "unknown"} 已启用；模式 ${sandbox.mode ?? "unknown"}；工作区 ${sandbox.workspaceRoot ?? "unknown"}。`,
			});
		}
	}

	if (snapshot.toolFailureGuard) {
		const guard = snapshot.toolFailureGuard;
		const protectedRuntime = guard.repeatLimit > 0 || guard.consecutiveLimit > 0 || guard.timeoutMs > 0;
		const unavailable = guard.tools.filter((tool) => tool.status === "open" || tool.status === "half-open");
		const pendingFailures = guard.tools.filter((tool) => tool.status === "closed");
		const timeout = guard.timeoutMs === 0 ? "不限制统一时长" : `单次最长 ${Math.ceil(guard.timeoutMs / 1_000)} 秒`;
		add({
			id: "tool-protection",
			area: "core",
			severity: unavailable.length > 0 ? "warning" : protectedRuntime ? "ok" : "info",
			label: "工具保护",
			detail:
				unavailable.length > 0
					? `已暂时停用：${unavailable.map((tool) => tool.name).join("、")}。`
					: protectedRuntime
						? `异常隔离和熔断已启用，${timeout}；当前没有停用工具${pendingFailures.length > 0 ? `，${pendingFailures.length} 个工具有失败记录` : ""}。`
						: "工具熔断和统一超时未启用。",
			...(unavailable.length > 0
				? { fix: "等待冷却后重试，开始新的用户任务，或先改用其他工具。" }
				: protectedRuntime
					? {}
					: { fix: "在 settings.json 启用 toolFailureGuard。" }),
		});
	}

	if (snapshot.toolApprovalMode) {
		const modeText =
			snapshot.toolApprovalMode === "yolo"
				? "普通操作直接执行，明确危险操作仍会确认。"
				: snapshot.toolApprovalMode === "write"
					? "读取和改文件直接执行，运行命令前会确认。"
					: "读取直接执行，改文件或运行命令前会确认。";
		add({
			id: "tool-approval",
			area: "core",
			severity: "ok",
			label: "工具确认",
			detail: modeText,
		});
	}

	const shell = resolveDoctorShell(snapshot, probes);
	add({
		id: "shell",
		area: "shell",
		severity: shell ? "ok" : "warning",
		label: snapshot.platform === "win32" ? "Git Bash" : "Bash",
		detail: shell ? `可执行文件：${shell.path}` : "没有找到可用 Bash。",
		...(shell
			? {}
			: {
					fix:
						snapshot.platform === "win32"
							? "安装 Git for Windows，或在 settings.json 设置 shellPath；不要使用 Windows System32 的旧 WSL bash.exe。"
							: "安装 bash，或确保 bash 所在目录已加入 PATH。",
				}),
	});

	const languages = detectProjectLanguages(snapshot, probes);
	if (languages.length === 0) {
		add({
			id: "project-language",
			area: "lsp",
			severity: "info",
			label: "项目语言",
			detail: "当前目录没有检测到 TypeScript/JavaScript、Python 或 Go 根标记。",
		});
	}
	if (languages.includes("typescript")) {
		const external = snapshot.isBunBinary
			? findExecutableOnPath("typescript-language-server", snapshot, probes)
			: "bundled";
		add({
			id: "lsp-typescript",
			area: "lsp",
			severity: external ? "ok" : "warning",
			label: "TypeScript/JavaScript LSP",
			detail: external
				? snapshot.isBunBinary
					? `已找到：${external}`
					: "语言服务器已随 Pi 安装。"
				: "独立二进制没有找到外部 TypeScript 语言服务器。",
			...(external ? {} : { fix: "npm install -g typescript-language-server typescript" }),
		});
	}
	if (languages.includes("python")) {
		const server = ["basedpyright-langserver", "pyright-langserver", "pylsp"]
			.map((command) => findExecutableOnPath(command, snapshot, probes))
			.find((candidate) => candidate !== undefined);
		add({
			id: "lsp-python",
			area: "lsp",
			severity: server ? "ok" : "warning",
			label: "Python LSP",
			detail: server ? `已找到：${server}` : "Python 项目缺少可用语言服务器。",
			...(server ? {} : { fix: "pip install basedpyright" }),
		});
	}
	if (languages.includes("go")) {
		const server = findExecutableOnPath("gopls", snapshot, probes);
		add({
			id: "lsp-go",
			area: "lsp",
			severity: server ? "ok" : "warning",
			label: "Go LSP",
			detail: server ? `已找到：${server}` : "Go 项目缺少 gopls。",
			...(server ? {} : { fix: "go install golang.org/x/tools/gopls@latest" }),
		});
	}

	const mgrep = findExecutableOnPath("mgrep", snapshot, probes);
	const codeSearchActive = snapshot.activeTools.includes("code_search");
	add({
		id: "mgrep",
		area: "search",
		severity: mgrep ? "ok" : codeSearchActive ? "warning" : "info",
		label: "语义代码搜索",
		detail: mgrep ? `mgrep 已安装：${mgrep}` : "mgrep 未安装；内置 grep 仍可正常使用。",
		...(mgrep ? {} : { fix: "需要语义搜索时运行：npm install -g @mixedbread/mgrep，然后运行 mgrep login。" }),
	});

	const webRegistered = registered.has("web_search");
	const webActive = snapshot.activeTools.includes("web_search");
	const braveConfigured = Boolean(environmentValue(snapshot.env, "BRAVE_API_KEY")?.trim());
	add({
		id: "web",
		area: "web",
		severity: webRegistered && webActive ? "ok" : "info",
		label: "联网搜索",
		detail:
			webRegistered && webActive
				? braveConfigured
					? "web_search 已启用，Brave Key 已配置；未读取 Key 内容。"
					: "web_search 已启用，可使用无 Key 的 DuckDuckGo 回退。"
				: "web_search 当前未启用。",
		...(webRegistered && webActive ? {} : { fix: "需要联网搜索时在 /tools 中开启 web_search。" }),
	});

	if (snapshot.settingsErrors.length > 0) {
		const settingsErrors = snapshot.settingsErrors.map((error) => {
			const settingsPath = error.scope === "project" ? snapshot.paths.projectSettings : snapshot.paths.settings;
			return `${settingsPath}: ${error.message}`;
		});
		add({
			id: "settings",
			area: "config",
			severity: "error",
			label: "设置文件",
			detail: settingsErrors.join("；"),
			fix: "修正上述 settings.json 的 JSON 格式。",
		});
	} else {
		add({
			id: "settings",
			area: "config",
			severity: "ok",
			label: "设置文件",
			detail:
				snapshot.configFiles.settings || snapshot.configFiles.projectSettings
					? "settings.json 已加载。"
					: "未创建全局或项目 settings.json，当前使用默认设置。",
		});
	}
	add({
		id: "auth-file",
		area: "config",
		severity: snapshot.configFiles.auth ? "ok" : "info",
		label: "认证文件",
		detail: snapshot.configFiles.auth ? "auth.json 存在；未读取文件内容。" : "auth.json 不存在。",
		...(snapshot.configFiles.auth ? {} : { fix: "需要保存认证时使用 /api 或 /login。" }),
	});

	return createDoctorReport(findings);
}
