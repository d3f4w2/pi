import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { getAgentDir, getAuthPath, getModelsPath, getSettingsPath, isBunBinary } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { runDoctorChecks } from "./checks.ts";
import { formatDoctorReport } from "./report.ts";
import type { DoctorFileProbes, DoctorSeverity, DoctorSnapshot } from "./types.ts";

export interface DoctorExtensionDependencies {
	collectSnapshot?: (pi: ExtensionAPI, ctx: ExtensionCommandContext, probes: DoctorFileProbes) => DoctorSnapshot;
	probes?: DoctorFileProbes;
}

const defaultDoctorProbes: DoctorFileProbes = {
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

function pickEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string | undefined>> {
	const selected: Record<string, string | undefined> = {};
	for (const name of ["PATH", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "BRAVE_API_KEY"]) {
		const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
		if (key !== undefined) selected[name] = environment[key];
	}
	return selected;
}

function collectDoctorSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	probes: DoctorFileProbes,
): DoctorSnapshot {
	const paths = {
		settings: getSettingsPath(),
		projectSettings: path.join(ctx.cwd, ".pi", "settings.json"),
		models: getModelsPath(),
		auth: getAuthPath(),
	};
	let customShellPath: string | undefined;
	let settingsErrors: DoctorSnapshot["settingsErrors"] = [];
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
		customShellPath = settings.getShellPath();
		settingsErrors = settings.drainErrors().map(({ scope, error }) => ({ scope, message: error.message }));
	} catch (error) {
		settingsErrors = [
			{
				scope: "global",
				message: `无法加载设置：${error instanceof Error ? error.message : String(error)}`,
			},
		];
	}
	const fileExists = (candidate: string): boolean => {
		try {
			return probes.fileExists(candidate);
		} catch {
			return false;
		}
	};
	const currentModel = ctx.model;
	const modelError = ctx.modelRegistry.getError();
	const toolFailureGuard = ctx.getToolFailureGuardStatus?.();
	return {
		platform: process.platform,
		cwd: ctx.cwd,
		env: pickEnvironment(process.env),
		...(customShellPath === undefined ? {} : { customShellPath }),
		settingsErrors,
		...(modelError === undefined ? {} : { modelError }),
		availableModelCount: ctx.modelRegistry.getAvailable().length,
		...(currentModel === undefined
			? {}
			: {
					currentModel: {
						provider: currentModel.provider,
						id: currentModel.id,
						hasConfiguredAuth: ctx.modelRegistry.hasConfiguredAuth(currentModel),
					},
				}),
		registeredTools: pi.getAllTools().map((tool) => tool.name),
		activeTools: pi.getActiveTools(),
		paths,
		configFiles: {
			settings: fileExists(paths.settings),
			projectSettings: fileExists(paths.projectSettings),
			models: fileExists(paths.models),
			auth: fileExists(paths.auth),
		},
		isBunBinary,
		...(toolFailureGuard === undefined ? {} : { toolFailureGuard }),
	};
}

function notificationType(severity: DoctorSeverity): "info" | "warning" | "error" {
	if (severity === "error") return "error";
	if (severity === "warning") return "warning";
	return "info";
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

export function createDoctorExtension(dependencies: DoctorExtensionDependencies = {}): (pi: ExtensionAPI) => void {
	const probes = dependencies.probes ?? defaultDoctorProbes;
	const collectSnapshot = dependencies.collectSnapshot ?? collectDoctorSnapshot;
	return (pi) => {
		pi.registerCommand("doctor", {
			description: "检查 Pi、工具和当前项目环境",
			handler: async (_args, ctx) => {
				ctx.ui.setStatus("doctor", "正在检查运行环境…");
				try {
					const snapshot = collectSnapshot(pi, ctx, probes);
					const report = runDoctorChecks(snapshot, probes);
					ctx.ui.notify(formatDoctorReport(report, snapshot.paths), notificationType(report.severity));
				} catch (error) {
					ctx.ui.notify(`健康检查失败：${conciseUnexpectedError(error)}`, "error");
				} finally {
					ctx.ui.setStatus("doctor", undefined);
				}
			},
		});
	};
}

export default createDoctorExtension();
