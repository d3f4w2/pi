import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { executeVerifyChild } from "../../cli/run-command.ts";
import type { RunVerificationContract } from "../../cli/run-contract.ts";
import type { RunVerificationEvidence } from "../../cli/run-receipt.ts";
import {
	compareWorkspaceSnapshots,
	getGitWorkspaceRoot,
	takeWorkspaceSnapshot,
	type WorkspaceSnapshot,
} from "../../cli/run-workspace.ts";
import { getAgentDir } from "../../config.ts";
import type {
	AgentSettledEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionCompactEvent,
	SessionStartEvent,
	SessionTreeEvent,
	ToolResultEvent,
	TurnEndEvent,
} from "../../core/extensions/types.ts";
import type { VerifyResult } from "../verify/types.ts";
import { type InteractiveCiResult, runInteractiveCi } from "./ci.ts";
import {
	formatGoalControlTitle,
	GOAL_RUN_PRESETS,
	goalControlActionFromLabel,
	goalControlOptions,
	goalStartArgumentsForPreset,
} from "./control.ts";
import {
	applyGoalVerification,
	beginGoalVerification,
	buildGoalIterationPrompt,
	createGoalLoopState,
	exhaustGoalBudget,
	failGoalLoop,
	formatGoalLoopStatus,
	formatGoalLoopWidget,
	goalBudgetBreach,
	goalLoopSystemContext,
	loadLatestGoalLoopState,
	normalizeGoalStartArguments,
	parseGoalLoopCommand,
	pauseGoalLoop,
	recordGoalTool,
	recordGoalTurn,
	recordGoalUsage,
	recordGoalVerificationEvidence,
	resumeGoalLoop,
	setGoalReceiptError,
	setGoalReceiptPath,
	setGoalReport,
	stopGoalLoop,
} from "./state.ts";
import { readGoalBaseline, writeGoalBaseline, writeGoalReceipt } from "./storage.ts";
import {
	GOAL_LOOP_ENTRY_TYPE,
	type GoalLoopReport,
	type GoalLoopStartArguments,
	type GoalLoopState,
	type GoalVerificationResult,
	MAX_GOAL_GAP_LENGTH,
	MAX_GOAL_QUESTION_LENGTH,
	MAX_GOAL_REPORT_LENGTH,
} from "./types.ts";

const GoalReportParams = Type.Object(
	{
		status: Type.Union([Type.Literal("complete"), Type.Literal("continue"), Type.Literal("needs_user")]),
		summary: Type.String({ minLength: 1, maxLength: MAX_GOAL_REPORT_LENGTH }),
		gap: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_GOAL_GAP_LENGTH })),
		question: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_GOAL_QUESTION_LENGTH })),
	},
	{ additionalProperties: false },
);

const TOOL_CHECKPOINT_INTERVAL = 10;

export interface GoalLoopDependencies {
	now: () => Date;
	randomUUID: () => string;
	getWorkspaceRoot: (cwd: string) => Promise<string>;
	takeSnapshot: (cwd: string) => Promise<WorkspaceSnapshot>;
	readBaseline: (filePath: string) => Promise<WorkspaceSnapshot>;
	writeBaseline: (agentDirectory: string, runId: string, snapshot: WorkspaceSnapshot) => Promise<string>;
	verify: (verification: RunVerificationContract, cwd: string, maxDurationMs?: number) => Promise<VerifyResult>;
	writeReceipt: (state: GoalLoopState) => Promise<string>;
	runCi: (input: string, cwd: string) => Promise<InteractiveCiResult>;
}

const defaultDependencies: GoalLoopDependencies = {
	now: () => new Date(),
	randomUUID,
	getWorkspaceRoot: getGitWorkspaceRoot,
	takeSnapshot: takeWorkspaceSnapshot,
	readBaseline: readGoalBaseline,
	writeBaseline: writeGoalBaseline,
	verify: executeVerifyChild,
	writeReceipt: writeGoalReceipt,
	runCi: runInteractiveCi,
};

function nowIso(dependencies: GoalLoopDependencies): string {
	return dependencies.now().toISOString();
}

function isActive(state: GoalLoopState | undefined): state is GoalLoopState {
	return state !== undefined && (state.status === "running" || state.status === "verifying");
}

function isTerminal(state: GoalLoopState): boolean {
	return ["verified", "budget_exhausted", "stopped", "failed"].includes(state.status);
}

function assistantText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") {
		return undefined;
	}
	if (!("content" in message) || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.flatMap((part) =>
			typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
				? [String(part.text)]
				: [],
		)
		.join("\n")
		.trim();
	return text || undefined;
}

function commandEvidence(command: string | undefined, workspaceRoot: string): string | undefined {
	if (!command) return undefined;
	return command.replaceAll("\\", "/").replaceAll(workspaceRoot.replaceAll("\\", "/"), ".").slice(0, 1000);
}

function verificationEvidence(
	contract: RunVerificationContract,
	result: VerifyResult,
	workspaceRoot: string,
): RunVerificationEvidence {
	return {
		operation: contract.operation,
		path: contract.path,
		passed: result.details.passed,
		durationMs: result.details.durationMs,
		checks: result.details.checks.map((check) => ({
			id: check.id,
			status: check.status,
			durationMs: check.durationMs,
			...(commandEvidence(check.command, workspaceRoot) === undefined
				? {}
				: { command: commandEvidence(check.command, workspaceRoot) }),
		})),
	};
}

function verificationGap(
	results: readonly { contract: RunVerificationContract; result?: VerifyResult; error?: string }[],
): string {
	const failures = results.filter((entry) => !entry.result?.details.passed);
	if (failures.length === 0) return "";
	return failures
		.map((entry) => {
			const label = `${entry.contract.operation}:${entry.contract.path}`;
			if (entry.error) return `${label} 无法执行：${entry.error}`;
			return `${label} 未通过：${entry.result?.text ?? "没有验证输出。"}`;
		})
		.join("\n")
		.slice(0, MAX_GOAL_GAP_LENGTH);
}

async function runIndependentVerification(
	state: GoalLoopState,
	dependencies: GoalLoopDependencies,
): Promise<GoalVerificationResult> {
	const results: Array<{ contract: RunVerificationContract; result?: VerifyResult; error?: string }> = [];
	for (const contract of state.verification) {
		const remainingMs =
			Date.parse(state.startedAt) + state.budget.timeoutSeconds * 1000 - dependencies.now().getTime();
		if (remainingMs <= 0) {
			results.push({ contract, error: "整体墙钟预算已耗尽。" });
			break;
		}
		try {
			results.push({
				contract,
				result: await dependencies.verify(contract, state.workspaceRoot, remainingMs),
			});
		} catch (error) {
			results.push({ contract, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const evidence = results.map(
		(entry): RunVerificationEvidence =>
			entry.result
				? verificationEvidence(entry.contract, entry.result, state.workspaceRoot)
				: {
						operation: entry.contract.operation,
						path: entry.contract.path,
						passed: false,
						durationMs: 0,
						checks: [],
					},
	);
	const snapshot = await dependencies.takeSnapshot(state.workspaceRoot);
	const baseline = await dependencies.readBaseline(state.baselinePath);
	const comparison = compareWorkspaceSnapshots(baseline, snapshot, state.scope);
	const report = state.iterations.at(-1)?.report;
	const deterministicGap = verificationGap(results);
	const workspaceGap = [
		...(comparison.headChanged ? ["Git HEAD 已变化；目标执行不允许自行提交。"] : []),
		...(comparison.scopeViolations.length > 0 ? [`存在范围外修改：${comparison.scopeViolations.join(", ")}`] : []),
	].join("\n");
	const objectiveGap = [deterministicGap, workspaceGap].filter(Boolean).join("\n");
	const gap = (
		objectiveGap ||
		(report?.status === "continue" ? report.gap : undefined) ||
		(report === undefined ? "Agent 本轮没有调用 goal_report，无法确认语义完成状态。" : "")
	).slice(0, MAX_GOAL_GAP_LENGTH);
	return {
		evidence,
		workspaceDigest: snapshot.digest,
		workspaceCompliance: {
			headChanged: comparison.headChanged,
			scopeViolations: comparison.scopeViolations,
		},
		gap,
		finishedAt: nowIso(dependencies),
	};
}

function helpText(): string {
	return `/run [目标和高级选项]

唯一交互入口。直接输入目标会立即开始；只输入 /run 会打开状态控制中心。

控制中心根据当前状态提供：开始、查看、暂停、继续、输入决策、停止和独立验收回执。无需记忆子命令。

直接启动的高级选项：
  --scope <path>              允许修改的 Git 相对范围，可重复
  --verify <op[:path]>        auto/typecheck/test/lint，可重复
  --timeout <seconds>         整体墙钟预算，默认 7200
  --max-tokens <count>        总 Token 预算，默认 400000
  --max-tool-calls <count>    总工具调用预算，默认 400
  --max-iterations <count>    最大执行轮数，默认 12

裸 /run 新建目标时可选快速 30 分钟、标准 2 小时或长跑 8 小时预设。所有预设都会在通过验收后立即结束。

例：/run --scope src --scope test --verify auto:. 修复解析器并补回归测试`;
}

function quoteGoalCommandArgument(value: string): string {
	return `"${value.replaceAll('"', '\\"')}"`;
}

export function createGoalLoopExtension(
	dependencies: GoalLoopDependencies = defaultDependencies,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		let currentState: GoalLoopState | undefined;
		let hardBudgetBreach: ReturnType<typeof goalBudgetBreach>;
		let wallTimer: ReturnType<typeof setTimeout> | undefined;
		let pendingControlRequest: "pause" | "stop" | undefined;
		let controlCenterOpen = false;
		let toolResultsSinceCheckpoint = 0;
		let startInFlight = false;
		let receiptWriteInFlight: { runId: string; promise: Promise<void> } | undefined;

		const clearWallTimer = () => {
			if (wallTimer !== undefined) clearTimeout(wallTimer);
			wallTimer = undefined;
		};

		const updateWidget = (ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			const widget = formatGoalLoopWidget(currentState);
			ctx.ui.setWidget("goal-loop", widget === undefined ? undefined : [widget], { placement: "belowEditor" });
		};

		const persist = (state: GoalLoopState, ctx: ExtensionContext) => {
			currentState = state;
			toolResultsSinceCheckpoint = 0;
			pi.appendEntry(GOAL_LOOP_ENTRY_TYPE, state);
			updateWidget(ctx);
		};

		const writeTerminalReceipt = async (ctx: ExtensionContext) => {
			const terminalState = currentState;
			if (!terminalState || !isTerminal(terminalState) || terminalState.receiptPath) return;
			if (receiptWriteInFlight?.runId === terminalState.runId) {
				await receiptWriteInFlight.promise;
				return;
			}
			const operation = (async () => {
				try {
					const receiptPath = await dependencies.writeReceipt(terminalState);
					if (currentState?.runId !== terminalState.runId || currentState.revision !== terminalState.revision) {
						return;
					}
					persist(setGoalReceiptPath(currentState, receiptPath, nowIso(dependencies)), ctx);
					ctx.ui.notify(`${formatGoalLoopStatus(currentState)}\n输入 /run 进行独立验收。`, "info");
				} catch (error) {
					if (currentState?.runId !== terminalState.runId || currentState.revision !== terminalState.revision) {
						return;
					}
					const reason = `写入目标回执失败：${error instanceof Error ? error.message : String(error)}`;
					persist(setGoalReceiptError(currentState, reason, nowIso(dependencies)), ctx);
					ctx.ui.notify(reason, "error");
				}
			})();
			receiptWriteInFlight = { runId: terminalState.runId, promise: operation };
			try {
				await operation;
			} finally {
				if (receiptWriteInFlight?.promise === operation) receiptWriteInFlight = undefined;
			}
		};

		const continueGoal = (state: GoalLoopState) => {
			pi.sendUserMessage(buildGoalIterationPrompt(state));
		};

		const startGoal = async (arguments_: GoalLoopStartArguments, ctx: ExtensionCommandContext) => {
			if (startInFlight) throw new Error("另一个目标正在启动；请等待当前启动完成。");
			startInFlight = true;
			const branchTipId = ctx.sessionManager.getBranch().at(-1)?.id;
			try {
				if (currentState && !isTerminal(currentState)) {
					throw new Error("已有未结束目标；输入 /run 打开控制中心。");
				}
				const workspaceRoot = await dependencies.getWorkspaceRoot(ctx.cwd);
				const normalized = normalizeGoalStartArguments(arguments_, workspaceRoot);
				const runId = dependencies.randomUUID();
				const baseline = await dependencies.takeSnapshot(workspaceRoot);
				const baselinePath = await dependencies.writeBaseline(getAgentDir(), runId, baseline);
				if (ctx.sessionManager.getBranch().at(-1)?.id !== branchTipId) {
					throw new Error("目标启动期间会话分支发生变化；未启动目标，请重试。");
				}
				const startedAt = nowIso(dependencies);
				let state = createGoalLoopState(normalized, { runId, workspaceRoot, baselinePath, now: startedAt });
				if (ctx.model) state = { ...state, model: { provider: ctx.model.provider, id: ctx.model.id } };
				pendingControlRequest = undefined;
				toolResultsSinceCheckpoint = 0;
				persist(state, ctx);
				ctx.ui.notify(`已启动目标 ${runId.slice(0, 8)}；第 1 轮开始。`, "info");
				continueGoal(state);
			} finally {
				startInFlight = false;
			}
		};

		const startGoalFromControlCenter = async (ctx: ExtensionCommandContext): Promise<boolean> => {
			const goal = await ctx.ui.input("工程目标", "描述最终必须达到且可以验收的结果");
			if (!goal?.trim()) return false;
			const presetLabel = await ctx.ui.select(
				"执行强度",
				GOAL_RUN_PRESETS.map((preset) => `${preset.label} · ${preset.description}`),
			);
			const preset = GOAL_RUN_PRESETS.find((entry) => presetLabel?.startsWith(entry.label));
			if (!preset) return false;
			await startGoal(goalStartArgumentsForPreset(goal, preset.id), ctx);
			return true;
		};

		const applyControlRequest = async (request: "pause" | "stop", ctx: ExtensionContext) => {
			if (!currentState) return;
			pendingControlRequest = undefined;
			if (request === "pause") {
				persist(pauseGoalLoop(currentState, "用户暂停执行；输入 /run 继续。", nowIso(dependencies)), ctx);
				ctx.ui.notify(formatGoalLoopStatus(currentState), "info");
				return;
			}
			persist(stopGoalLoop(currentState, nowIso(dependencies)), ctx);
			await writeTerminalReceipt(ctx);
		};

		const requestControl = async (request: "pause" | "stop", ctx: ExtensionCommandContext): Promise<void> => {
			if (!currentState) throw new Error("当前没有目标。");
			if (currentState.status === "verifying") {
				pendingControlRequest = request;
				ctx.ui.notify(request === "pause" ? "独立验证结束后暂停。" : "独立验证结束后停止并生成回执。", "info");
				return;
			}
			if (currentState.status === "running" && !ctx.isIdle()) {
				pendingControlRequest = request;
				ctx.abort();
				ctx.ui.notify(
					request === "pause" ? "正在结束当前 Agent 回合，随后暂停。" : "正在结束当前 Agent 回合，随后停止。",
					"info",
				);
				return;
			}
			await applyControlRequest(request, ctx);
		};

		const runReceiptAcceptance = async (ctx: ExtensionCommandContext) => {
			if (!currentState?.receiptPath) throw new Error("当前目标还没有可验收回执。");
			const result = await dependencies.runCi(quoteGoalCommandArgument(currentState.receiptPath), ctx.cwd);
			const message = `${result.stdout}${result.stderr}`.trim() || `Pigo CI exit ${result.exitCode}`;
			ctx.ui.notify(message, result.exitCode === 0 ? "info" : "error");
		};

		const finishGoalVerification = async (ctx: ExtensionContext, enterVerification: boolean) => {
			if (!currentState) return;
			let verificationCheckpoint: { runId: string; revision: number } | undefined;
			try {
				if (enterVerification) {
					if (currentState.status !== "running") return;
					persist(beginGoalVerification(currentState, nowIso(dependencies)), ctx);
				} else if (currentState.status !== "verifying") {
					return;
				}
				verificationCheckpoint = { runId: currentState.runId, revision: currentState.revision };
				ctx.ui.notify(`第 ${currentState.iteration} 轮结束，正在独立验证…`, "info");
				const verification = await runIndependentVerification(currentState, dependencies);
				if (
					currentState.runId !== verificationCheckpoint.runId ||
					currentState.revision !== verificationCheckpoint.revision ||
					currentState.status !== "verifying"
				) {
					return;
				}
				if (pendingControlRequest) {
					persist(recordGoalVerificationEvidence(currentState, verification), ctx);
					await applyControlRequest(pendingControlRequest, ctx);
					return;
				}
				const verifiedState = applyGoalVerification(currentState, verification);
				persist(verifiedState, ctx);
				if (verifiedState.status === "running") {
					ctx.ui.notify(`独立验证仍有差距，自动开始第 ${verifiedState.iteration} 轮纠偏。`, "info");
					continueGoal(verifiedState);
					return;
				}
				if (isTerminal(verifiedState)) await writeTerminalReceipt(ctx);
				else ctx.ui.notify(formatGoalLoopStatus(verifiedState), "info");
			} catch (error) {
				if (
					verificationCheckpoint &&
					(currentState?.runId !== verificationCheckpoint.runId ||
						currentState.revision !== verificationCheckpoint.revision)
				) {
					return;
				}
				if (!currentState) return;
				const reason = `目标验证协调失败：${error instanceof Error ? error.message : String(error)}`;
				persist(failGoalLoop(currentState, reason, nowIso(dependencies)), ctx);
				await writeTerminalReceipt(ctx);
			}
		};

		const showControlCenter = async (ctx: ExtensionCommandContext) => {
			if (controlCenterOpen) {
				ctx.ui.notify("/run 控制中心已经打开。", "warning");
				return;
			}
			controlCenterOpen = true;
			try {
				if (currentState && isTerminal(currentState) && !currentState.receiptPath) {
					await writeTerminalReceipt(ctx);
				}
				while (true) {
					const options = goalControlOptions(currentState);
					const selected = await ctx.ui.select(
						formatGoalControlTitle(currentState, dependencies.now().getTime()),
						options.map((entry) => entry.label),
					);
					const action = goalControlActionFromLabel(currentState, selected);
					if (!action || action === "close") return;
					if (action === "status") {
						ctx.ui.notify(formatGoalLoopStatus(currentState), "info");
						continue;
					}
					if (action === "help") {
						ctx.ui.notify(helpText(), "info");
						continue;
					}
					if (action === "start") {
						await startGoalFromControlCenter(ctx);
						return;
					}
					if (action === "accept") {
						await runReceiptAcceptance(ctx);
						continue;
					}
					if (action === "retry_receipt") {
						await writeTerminalReceipt(ctx);
						continue;
					}
					if (!currentState) throw new Error("当前没有目标。");
					if (action === "resume") {
						const state = resumeGoalLoop(currentState, undefined, nowIso(dependencies));
						pendingControlRequest = undefined;
						persist(state, ctx);
						if (state.status === "running") continueGoal(state);
						else if (state.status === "verifying") await finishGoalVerification(ctx, false);
						else if (isTerminal(state)) await writeTerminalReceipt(ctx);
						return;
					}
					if (action === "decide") {
						const decision = await ctx.ui.input("提供决策并继续", currentState.reason ?? "输入你的决定");
						if (!decision?.trim()) continue;
						const state = resumeGoalLoop(currentState, decision, nowIso(dependencies));
						pendingControlRequest = undefined;
						persist(state, ctx);
						continueGoal(state);
						return;
					}
					await requestControl(action, ctx);
					return;
				}
			} finally {
				controlCenterOpen = false;
			}
		};

		pi.registerTool({
			name: "goal_report",
			label: "目标轮次报告",
			description: "在 /run 目标执行的每轮最后报告完成、可继续的差距，或一个确实需要用户决定的问题。",
			promptSnippet: "目标执行每轮结束前最后调用 goal_report；它不替代独立验证。",
			promptGuidelines: [
				"只在 /run 启动的目标执行中使用，并且每轮最多调用一次。",
				"status=complete 只表示你认为目标已经满足，Pigo 仍会在模型外独立验证。",
				"能根据测试或代码继续自主修复时使用 continue；只有产品行为、范围或不可逆选择需要用户决定时使用 needs_user。",
			],
			parameters: GoalReportParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!currentState || currentState.status !== "running") throw new Error("当前没有 /run 目标轮次。");
				const report: GoalLoopReport = {
					status: params.status,
					summary: params.summary,
					...(params.gap === undefined ? {} : { gap: params.gap }),
					...(params.question === undefined ? {} : { question: params.question }),
				};
				persist(setGoalReport(currentState, report, nowIso(dependencies)), ctx);
				return {
					content: [{ type: "text", text: `已记录第 ${currentState.iteration} 轮状态：${report.status}` }],
					details: { runId: currentState.runId, iteration: currentState.iteration, status: report.status },
				};
			},
		});

		pi.registerCommand("run", {
			description: "唯一工程执行入口：开始、控制、恢复和独立验收",
			handler: async (input, ctx) => {
				try {
					const command = parseGoalLoopCommand(input);
					if (command.action === "control") await showControlCenter(ctx);
					else await startGoal(command.arguments, ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		const restore = async (ctx: ExtensionContext) => {
			clearWallTimer();
			pendingControlRequest = undefined;
			toolResultsSinceCheckpoint = 0;
			currentState = loadLatestGoalLoopState(ctx.sessionManager.getBranch());
			if (isActive(currentState)) {
				currentState = pauseGoalLoop(
					currentState,
					"上次目标执行在活动状态中断；为避免静默恢复权限，请显式打开 /run 继续。",
					nowIso(dependencies),
				);
				persist(currentState, ctx);
			}
			updateWidget(ctx);
			if (currentState && isTerminal(currentState) && !currentState.receiptPath) await writeTerminalReceipt(ctx);
		};

		pi.on("session_start", (_event: SessionStartEvent, ctx) => restore(ctx));
		pi.on("session_tree", (_event: SessionTreeEvent, ctx) => restore(ctx));
		pi.on("session_compact", async (event: SessionCompactEvent, ctx) => {
			if (!currentState || currentState.status !== "running" || !event.compactionEntry.usage) return;
			currentState = recordGoalUsage(currentState, event.compactionEntry.usage, nowIso(dependencies));
			const breach = goalBudgetBreach(currentState, dependencies.now().getTime());
			if (breach) {
				pendingControlRequest = undefined;
				hardBudgetBreach = breach;
				currentState = exhaustGoalBudget(currentState, breach, nowIso(dependencies));
				persist(currentState, ctx);
				ctx.abort();
				await writeTerminalReceipt(ctx);
				return;
			}
			persist(currentState, ctx);
		});
		pi.on("before_agent_start", (event: BeforeAgentStartEvent): BeforeAgentStartEventResult | undefined => {
			if (!currentState || currentState.status !== "running") return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${goalLoopSystemContext(currentState)}` };
		});
		pi.on("agent_start", (_event, ctx) => {
			clearWallTimer();
			hardBudgetBreach = undefined;
			if (!currentState || currentState.status !== "running") return;
			const remainingMs =
				Date.parse(currentState.startedAt) +
				currentState.budget.timeoutSeconds * 1000 -
				dependencies.now().getTime();
			wallTimer = setTimeout(
				() => {
					hardBudgetBreach = "timeout";
					ctx.abort();
				},
				Math.max(0, remainingMs),
			);
		});
		pi.on("tool_result", (event: ToolResultEvent, ctx) => {
			if (!currentState || currentState.status !== "running") return;
			currentState = recordGoalTool(currentState, event, nowIso(dependencies));
			toolResultsSinceCheckpoint += 1;
			if (toolResultsSinceCheckpoint >= TOOL_CHECKPOINT_INTERVAL) {
				toolResultsSinceCheckpoint = 0;
				persist(currentState, ctx);
			}
			const breach = goalBudgetBreach(currentState, dependencies.now().getTime());
			if (breach && breach !== "iteration_budget") {
				hardBudgetBreach = breach;
				ctx.abort();
			}
		});
		pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
			if (!currentState || currentState.status !== "running" || event.message.role !== "assistant") return;
			currentState = recordGoalTurn(
				currentState,
				event.message.usage,
				assistantText(event.message),
				nowIso(dependencies),
			);
			if (hardBudgetBreach) {
				pendingControlRequest = undefined;
				currentState = exhaustGoalBudget(currentState, hardBudgetBreach, nowIso(dependencies));
				persist(currentState, ctx);
				return;
			}
			if (pendingControlRequest) {
				const request = pendingControlRequest;
				await applyControlRequest(request, ctx);
				return;
			}
			if (event.message.stopReason === "aborted") {
				currentState = pauseGoalLoop(currentState, "当前 Agent 回合已中断；输入 /run 继续。", nowIso(dependencies));
				persist(currentState, ctx);
			}
			if (event.message.stopReason === "error") {
				currentState = failGoalLoop(currentState, "Agent 回合失败。", nowIso(dependencies));
				persist(currentState, ctx);
			}
		});
		pi.on("agent_settled", async (_event: AgentSettledEvent, ctx) => {
			clearWallTimer();
			if (!currentState) return;
			if (pendingControlRequest && currentState.status === "running") {
				await applyControlRequest(pendingControlRequest, ctx);
				return;
			}
			if (isTerminal(currentState)) {
				await writeTerminalReceipt(ctx);
				return;
			}
			if (currentState.status !== "running") return;
			await finishGoalVerification(ctx, true);
		});
		pi.on("session_shutdown", (_event, ctx) => {
			clearWallTimer();
			if (currentState && toolResultsSinceCheckpoint > 0) persist(currentState, ctx);
			if (ctx.hasUI) ctx.ui.setWidget("goal-loop", undefined, { placement: "belowEditor" });
		});
	};
}

export default createGoalLoopExtension();
