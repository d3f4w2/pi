import type { DoctorPaths, DoctorReport, DoctorSeverity } from "./types.ts";

const MAX_REPORT_CHARACTERS = 12_000;

const severityLabels: Readonly<Record<DoctorSeverity, string>> = {
	error: "错误",
	warning: "提醒",
	info: "可选",
	ok: "正常",
};

const areaLabels = {
	core: "核心",
	shell: "终端",
	lsp: "代码理解",
	search: "代码搜索",
	web: "联网",
	config: "配置",
} as const;

function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

function truncate(value: string, maxCharacters: number): string {
	const characters = Array.from(value);
	if (characters.length <= maxCharacters) return value;
	return `${characters.slice(0, Math.max(0, maxCharacters - 8)).join("")}\n[已截断]`;
}

export function formatDoctorReport(report: DoctorReport, paths: DoctorPaths): string {
	const lines = [
		"Pi 健康检查",
		`结果：${report.summary.error} 错误 · ${report.summary.warning} 提醒 · ${report.summary.info} 可选 · ${report.summary.ok} 正常`,
	];
	for (const finding of report.findings) {
		lines.push(`\n[${severityLabels[finding.severity]}] ${areaLabels[finding.area]} · ${finding.label}`);
		lines.push(`  ${finding.detail}`);
		if (finding.fix) lines.push(`  修复：${finding.fix}`);
	}
	lines.push("\n配置位置（只显示路径，不读取凭据内容）");
	lines.push(`  settings.json: ${clean(paths.settings)}`);
	lines.push(`  项目 settings.json: ${clean(paths.projectSettings)}`);
	lines.push(`  models.json: ${clean(paths.models)}`);
	lines.push(`  auth.json: ${clean(paths.auth)}`);
	lines.push("\n说明：这是离线检查，不代表远端服务当前一定在线。");
	return truncate(lines.join("\n"), MAX_REPORT_CHARACTERS);
}
