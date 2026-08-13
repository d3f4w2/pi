import { type GoalLoopStartArguments, type GoalLoopState, type GoalLoopStatus, MAX_GOAL_LENGTH } from "./types.ts";

export type GoalControlAction =
	| "start"
	| "status"
	| "pause"
	| "resume"
	| "decide"
	| "stop"
	| "accept"
	| "retry_receipt"
	| "help"
	| "close";

export interface GoalControlOption {
	id: GoalControlAction;
	label: string;
}

export type GoalRunPresetId = "quick" | "standard" | "long";

export interface GoalRunPreset {
	id: GoalRunPresetId;
	label: string;
	description: string;
	budget: GoalLoopStartArguments["budget"];
}

export const GOAL_RUN_PRESETS: readonly GoalRunPreset[] = [
	{
		id: "quick",
		label: "快速 · 30 分钟",
		description: "聚焦修复与小范围改动",
		budget: { timeoutSeconds: 1_800, maxTokens: 200_000, maxToolCalls: 200, maxIterations: 8 },
	},
	{
		id: "standard",
		label: "标准 · 2 小时",
		description: "常规仓库工程任务",
		budget: { timeoutSeconds: 7_200, maxTokens: 400_000, maxToolCalls: 400, maxIterations: 12 },
	},
	{
		id: "long",
		label: "长跑 · 8 小时",
		description: "迁移、重构与跨模块目标",
		budget: { timeoutSeconds: 28_800, maxTokens: 1_000_000, maxToolCalls: 1_000, maxIterations: 32 },
	},
];

export const GOAL_STATUS_LABELS: Readonly<Record<GoalLoopStatus, string>> = {
	running: "执行中",
	verifying: "独立验证中",
	paused: "已暂停",
	waiting_user: "等待决策",
	verified: "已通过",
	budget_exhausted: "预算耗尽",
	stuck: "停滞待决策",
	stopped: "已停止",
	failed: "失败",
};

function option(id: GoalControlAction, label: string): GoalControlOption {
	return { id, label };
}

export function goalControlOptions(state: GoalLoopState | undefined): GoalControlOption[] {
	if (!state) return [option("start", "开始新目标"), option("help", "使用说明"), option("close", "关闭")];
	if (state.status === "running") {
		return [
			option("status", "查看状态"),
			option("pause", "暂停执行"),
			option("stop", "停止并生成回执"),
			option("close", "关闭"),
		];
	}
	if (state.status === "verifying") {
		return [
			option("status", "查看状态"),
			option("pause", "验证后暂停"),
			option("stop", "验证后停止并生成回执"),
			option("close", "关闭"),
		];
	}
	if (state.status === "paused") {
		return [
			option("status", "查看状态"),
			option("resume", "继续执行"),
			option("stop", "停止并生成回执"),
			option("close", "关闭"),
		];
	}
	if (state.status === "waiting_user" || state.status === "stuck") {
		return [
			option("status", "查看状态"),
			option("decide", "提供决策并继续"),
			option("stop", "停止并生成回执"),
			option("close", "关闭"),
		];
	}
	if (!state.receiptPath) {
		return [option("status", "查看结果"), option("retry_receipt", "重试生成回执"), option("close", "关闭")];
	}
	return [
		option("status", "查看结果"),
		option("accept", "独立验收回执"),
		option("start", "开始新目标"),
		option("close", "关闭"),
	];
}

export function goalControlActionFromLabel(
	state: GoalLoopState | undefined,
	label: string | undefined,
): GoalControlAction | undefined {
	if (label === undefined) return undefined;
	return goalControlOptions(state).find((entry) => entry.label === label)?.id;
}

export function formatGoalDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const remainder = seconds % 60;
	return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function formatGoalControlTitle(state: GoalLoopState | undefined, nowMs = Date.now()): string {
	if (!state) return "Pigo 工程执行 · 当前没有目标";
	const deadline = Date.parse(state.startedAt) + state.budget.timeoutSeconds * 1_000;
	return `Pigo 工程执行 · ${GOAL_STATUS_LABELS[state.status]} · 第 ${state.iteration}/${state.budget.maxIterations} 轮 · 剩余 ${formatGoalDuration((deadline - nowMs) / 1_000)}`;
}

export function goalStartArgumentsForPreset(goal: string, presetId: GoalRunPresetId): GoalLoopStartArguments {
	const normalizedGoal = goal.replace(/\s+/gu, " ").trim();
	if (!normalizedGoal) throw new Error("目标不能为空。");
	if (normalizedGoal.length > MAX_GOAL_LENGTH) throw new Error(`目标最多 ${MAX_GOAL_LENGTH} 个字符。`);
	const preset = GOAL_RUN_PRESETS.find((entry) => entry.id === presetId);
	if (!preset) throw new Error(`未知执行预设：${presetId}`);
	return {
		goal: normalizedGoal,
		scope: ["."],
		verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
		budget: { ...preset.budget },
	};
}
