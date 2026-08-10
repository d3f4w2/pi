import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { t } from "../../modes/interactive/i18n/index.ts";
import { AGENT_EVAL_CASES } from "../evals/agent-cases.ts";
import { AGENT_EVAL_REPORT_ENTRY, type AgentEvalReportEntryData } from "../evals/agent-report.ts";
import { IsolatedAgentEvalRunner } from "../evals/agent-runner.ts";
import { AgentEvalResultStore } from "../evals/agent-store.ts";
import type {
	AgentEvalCase,
	AgentEvalProgress,
	AgentEvalResultStoreLike,
	AgentEvalRunnerLike,
} from "../evals/types.ts";
import { resolveProjectMemoryScope } from "../memory/evidence.ts";
import { RUN_METRICS_RECORDED_EVENT, type RunRecord } from "../run-metrics/types.ts";
import { EvolutionStore, promptContextFromSnapshot } from "./storage.ts";
import type {
	CanaryRunOutcome,
	EvolutionCandidate,
	EvolutionCandidateDraft,
	EvolutionProjectScope,
	EvolutionSignal,
	EvolutionSnapshot,
} from "./types.ts";

const INTERNAL_TOOL = "improvement_candidate";
const GRANT_TTL_MS = 5 * 60 * 1000;
const CANARY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"code_search",
	"lsp",
	"ast_grep",
	"edit",
	"write",
	"verify",
]);

const CandidateParams = Type.Object(
	{
		grantId: Type.String({ minLength: 1, maxLength: 100, description: "一次性用户授权 ID" }),
		title: Type.String({ minLength: 1, maxLength: 120, description: "候选标题" }),
		problem: Type.String({ minLength: 1, maxLength: 500, description: "重复出现的问题" }),
		hypothesis: Type.String({ minLength: 1, maxLength: 500, description: "为什么这条规则可能改善问题" }),
		kind: Type.Union([Type.Literal("prompt"), Type.Literal("strategy")]),
		instruction: Type.String({ minLength: 1, maxLength: 1_000, description: "短、可执行的行为规则" }),
		triggerTerms: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 8 }),
		expectedEffect: Type.String({ minLength: 1, maxLength: 500 }),
		risk: Type.String({ minLength: 1, maxLength: 500 }),
		evalCaseId: Type.String({ minLength: 1, maxLength: 100, description: "最相关的内置 Agent 评测案例 ID" }),
	},
	{ additionalProperties: false },
);

interface CandidateGrant {
	id: string;
	signal: EvolutionSignal;
	scope: EvolutionProjectScope;
	expiresAt: number;
}

interface PendingObservation {
	promise: Promise<{ signal?: EvolutionSignal; becameEligible: boolean }>;
}

function isRunRecord(value: unknown): value is RunRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 2 &&
		"id" in value &&
		typeof value.id === "string" &&
		"outcome" in value &&
		typeof value.outcome === "string"
	);
}

function projectScope(cwd: string): EvolutionProjectScope {
	const scope = resolveProjectMemoryScope(cwd);
	return { projectId: scope.projectId };
}

function signalSummary(signal: EvolutionSignal): string {
	const tools = signal.toolErrors.length > 0 ? signal.toolErrors.join(", ") : t("learning.signalNoTool");
	return t("learning.signalSummary", {
		count: signal.occurrences,
		outcome: t(`learning.outcome.${signal.outcome}`),
		tools,
		retries: signal.retries,
	});
}

function candidatePreview(candidate: EvolutionCandidate | EvolutionCandidateDraft): string {
	return [
		`${t("learning.previewTitle")}：${candidate.title}`,
		`${t("learning.previewProblem")}：${candidate.problem}`,
		`${t("learning.previewHypothesis")}：${candidate.hypothesis}`,
		`${t("learning.previewKind")}：${t(`learning.kind.${candidate.kind}`)}`,
		`${t("learning.previewRule")}：${candidate.instruction}`,
		...(candidate.triggerTerms.length > 0
			? [`${t("learning.previewTriggers")}：${candidate.triggerTerms.join(", ")}`]
			: []),
		`${t("learning.previewEffect")}：${candidate.expectedEffect}`,
		`${t("learning.previewRisk")}：${candidate.risk}`,
		`${t("learning.previewCase")}：${candidate.evalCaseId}`,
	].join("\n");
}

function statusLabel(status: EvolutionCandidate["status"]): string {
	return t(`learning.status.${status}`);
}

function candidateChoice(candidate: EvolutionCandidate): string {
	return `${statusLabel(candidate.status)} · ${candidate.id.slice(0, 8)} · ${candidate.title.slice(0, 42)}`;
}

async function chooseCandidate(
	candidates: readonly EvolutionCandidate[],
	ctx: ExtensionCommandContext,
	title: string,
): Promise<EvolutionCandidate | undefined> {
	if (candidates.length === 0) {
		ctx.ui.notify(t("learning.noCandidate"), "info");
		return undefined;
	}
	if (!ctx.hasUI) return candidates.at(-1);
	const choices = candidates.map(candidateChoice);
	const selected = await ctx.ui.select(title, choices);
	const index = selected === undefined ? -1 : choices.indexOf(selected);
	return index < 0 ? undefined : candidates[index];
}

function formatSnapshot(snapshot: EvolutionSnapshot): string {
	const eligible = snapshot.signals.filter((signal) => signal.status === "eligible").length;
	const active = snapshot.candidates.filter((candidate) =>
		new Set(["canary", "awaiting_promotion", "promoted"]).has(candidate.status),
	);
	const recent = [...snapshot.candidates].reverse().slice(0, 5);
	return [
		t("learning.statusTitle"),
		t("learning.statusObservation", {
			state: snapshot.settings.enabled ? t("common.on") : t("common.off"),
			threshold: snapshot.settings.signalThreshold,
		}),
		t("learning.statusCounts", {
			eligible,
			candidates: snapshot.candidates.length,
			active: active.length,
		}),
		...(recent.length > 0
			? ["", t("learning.statusRecent"), ...recent.map((candidate) => `- ${candidateChoice(candidate)}`)]
			: ["", t("learning.noCandidate")]),
	].join("\n");
}

function formatCandidateHistory(candidate: EvolutionCandidate, snapshot: EvolutionSnapshot): string {
	const evaluation = candidate.evaluations.at(-1);
	const events = snapshot.events.filter((event) => event.subjectId === candidate.id).slice(-10);
	return [
		candidatePreview(candidate),
		"",
		t("learning.historyState", { status: statusLabel(candidate.status), digest: candidate.digest.slice(0, 16) }),
		t("learning.historySource", {
			signal: candidate.sourceSignalId.slice(0, 12),
			parent: candidate.parentId?.slice(0, 12) ?? "-",
		}),
		...(evaluation
			? [
					t("learning.historyEval", {
						gate: evaluation.gatePassed ? t("agentEval.reportPass") : t("agentEval.reportFail"),
						baseline: evaluation.baseline.passed ? t("agentEval.reportPass") : t("agentEval.reportFail"),
						candidate: evaluation.candidate.passed ? t("agentEval.reportPass") : t("agentEval.reportFail"),
					}),
					t("learning.historyCost", {
						baselineTokens: evaluation.baseline.totalTokens,
						candidateTokens: evaluation.candidate.totalTokens,
						baselineMs: Math.round(evaluation.baseline.durationMs),
						candidateMs: Math.round(evaluation.candidate.durationMs),
					}),
					...(evaluation.reasons.length > 0
						? [t("learning.historyReasons", { value: evaluation.reasons.join("；") })]
						: []),
					...(evaluation.warnings.length > 0
						? [t("learning.historyWarnings", { value: evaluation.warnings.join("；") })]
						: []),
				]
			: []),
		...(candidate.canary
			? [
					t("learning.historyCanary", {
						success: candidate.canary.successfulRuns,
						total: candidate.canary.totalRuns,
						remaining: candidate.canary.remainingRuns,
					}),
				]
			: []),
		...(events.length > 0
			? ["", t("learning.historyEvents"), ...events.map((event) => `- ${event.timestamp} · ${event.type}`)]
			: []),
	].join("\n");
}

function progressLines(
	phase: string,
	testCase: AgentEvalCase,
	progress: AgentEvalProgress,
	startedAt: number,
): string[] {
	return [
		t("learning.evalProgressTitle", { phase }),
		`› ${testCase.title}`,
		`│ ${t(`agentEval.stage.${progress.stage}`, { tool: progress.toolName ?? "" })}`,
		`│ ${t("agentEval.progressMetrics", {
			seconds: Math.round((Date.now() - startedAt) / 1_000),
			tools: progress.toolCalls,
		})}`,
		...(progress.detail ? [`│ ${progress.detail.slice(0, 80)}`] : []),
	];
}

export function createLearningExtension(
	store: EvolutionStore = new EvolutionStore(),
	runner: AgentEvalRunnerLike = new IsolatedAgentEvalRunner(),
	resultStore: AgentEvalResultStoreLike = new AgentEvalResultStore(path.join(getAgentDir(), "learning", "evals")),
	now: () => Date = () => new Date(),
): (pi: ExtensionAPI) => void {
	return (pi) => {
		let scope: EvolutionProjectScope | undefined;
		let grant: CandidateGrant | undefined;
		let generationRun = false;
		let unusedGrant = false;
		let pendingObservation: PendingObservation | undefined;
		let pendingEligibleSignal: EvolutionSignal | undefined;
		let appliedCanaryId: string | undefined;
		let pendingCanaryOutcome: Promise<CanaryRunOutcome> | undefined;
		let cachedSnapshot: EvolutionSnapshot | undefined;

		const deactivateInternalTool = (): void => {
			const active = pi.getActiveTools();
			if (active.includes(INTERNAL_TOOL)) pi.setActiveTools(active.filter((name) => name !== INTERNAL_TOOL));
		};
		const revokeGrant = (): void => {
			grant = undefined;
			deactivateInternalTool();
		};
		const startGeneration = (signal: EvolutionSignal): void => {
			const activeGrant: CandidateGrant = {
				id: randomUUID(),
				signal,
				scope: signal.scope,
				expiresAt: now().getTime() + GRANT_TTL_MS,
			};
			grant = activeGrant;
			const active = pi.getActiveTools();
			if (!active.includes(INTERNAL_TOOL)) pi.setActiveTools([...active, INTERNAL_TOOL]);
			const cases = AGENT_EVAL_CASES.map((testCase) => `${testCase.id}: ${testCase.title}`).join("\n");
			pi.sendUserMessage(
				t("learning.agentInstruction", {
					grantId: activeGrant.id,
					summary: signalSummary(signal),
					cases,
				}),
				{ deliverAs: "followUp" },
			);
		};

		pi.registerTool<typeof CandidateParams, { status: "proposed" | "rejected" | "denied"; candidateId?: string }>({
			name: INTERNAL_TOOL,
			label: t("learning.toolLabel"),
			description: t("learning.toolDescription"),
			parameters: CandidateParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const activeGrant = grant;
				if (!activeGrant || params.grantId !== activeGrant.id || now().getTime() > activeGrant.expiresAt) {
					revokeGrant();
					return { content: [{ type: "text", text: t("learning.noGrant") }], details: { status: "denied" } };
				}
				try {
					if (!AGENT_EVAL_CASES.some((testCase) => testCase.id === params.evalCaseId)) {
						return {
							content: [{ type: "text", text: t("learning.invalidCase", { id: params.evalCaseId }) }],
							details: { status: "denied" },
						};
					}
					const draft: EvolutionCandidateDraft = {
						title: params.title,
						problem: params.problem,
						hypothesis: params.hypothesis,
						kind: params.kind,
						instruction: params.instruction,
						triggerTerms: [...params.triggerTerms],
						expectedEffect: params.expectedEffect,
						risk: params.risk,
						evalCaseId: params.evalCaseId,
					};
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: t("learning.reviewUnavailable") }],
							details: { status: "denied" },
						};
					}
					const approved = await ctx.ui.confirm(t("learning.reviewTitle"), candidatePreview(draft));
					if (!approved) {
						return {
							content: [{ type: "text", text: t("learning.reviewRejected") }],
							details: { status: "rejected" },
						};
					}
					const candidate = await store.propose(activeGrant.signal.id, draft, activeGrant.scope);
					return {
						content: [{ type: "text", text: t("learning.proposed", { id: candidate.id }) }],
						details: { status: "proposed", candidateId: candidate.id },
					};
				} finally {
					revokeGrant();
				}
			},
		});

		pi.events.on(RUN_METRICS_RECORDED_EVENT, (data) => {
			if (!scope || !isRunRecord(data)) return;
			const runScope = scope;
			pendingObservation = { promise: store.observeRun(runScope, data) };
			if (appliedCanaryId) {
				pendingCanaryOutcome = store.recordCanaryRun(appliedCanaryId, data, runScope);
				appliedCanaryId = undefined;
			}
		});

		pi.on("session_start", (_event, ctx) => {
			scope = projectScope(ctx.cwd);
			cachedSnapshot = undefined;
			deactivateInternalTool();
		});

		pi.on("before_agent_start", async (event, ctx) => {
			if (grant) return undefined;
			const runScope = scope ?? projectScope(ctx.cwd);
			cachedSnapshot ??= await store.snapshot(runScope);
			const context = promptContextFromSnapshot(cachedSnapshot, event.prompt);
			appliedCanaryId = context.canaryCandidateId;
			if (!context.systemPrompt) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${context.systemPrompt}` };
		});

		pi.on("agent_start", () => {
			generationRun = !!grant;
		});
		pi.on("tool_call", (event) => {
			if (event.toolName === INTERNAL_TOOL) return undefined;
			if (grant || generationRun) return { block: true, reason: t("learning.blockedTool") };
			if (appliedCanaryId && !CANARY_TOOLS.has(event.toolName)) {
				return { block: true, reason: t("learning.canaryBlockedTool", { tool: event.toolName }) };
			}
			return undefined;
		});
		pi.on("agent_end", () => {
			if (!generationRun) return;
			generationRun = false;
			if (grant) {
				unusedGrant = true;
				revokeGrant();
			}
		});

		pi.on("agent_settled", async (_event, ctx) => {
			if (pendingCanaryOutcome) {
				try {
					const outcome = await pendingCanaryOutcome;
					if (outcome.action === "rolled_back") ctx.ui.notify(t("learning.canaryAutoRollback"), "warning");
					if (outcome.action === "awaiting_promotion") ctx.ui.notify(t("learning.canaryReady"), "info");
				} catch (error) {
					ctx.ui.notify(
						t("learning.operationFailed", { error: error instanceof Error ? error.message : String(error) }),
						"warning",
					);
				} finally {
					pendingCanaryOutcome = undefined;
					cachedSnapshot = undefined;
				}
			}
			if (unusedGrant) {
				unusedGrant = false;
				ctx.ui.notify(t("learning.unusedGrant"), "warning");
				return;
			}
			if (pendingObservation) {
				try {
					const observation = await pendingObservation.promise;
					if (observation.becameEligible) pendingEligibleSignal = observation.signal;
				} catch {
					// Learning is best-effort and must never block the completed task.
				} finally {
					pendingObservation = undefined;
				}
			}
			const signal = pendingEligibleSignal;
			pendingEligibleSignal = undefined;
			if (!signal || !ctx.hasUI || grant) return;
			ctx.ui.notify(t("learning.detected", { summary: signalSummary(signal) }), "info");
			const allow = t("learning.allowGeneration");
			const suppress = t("learning.suppressSignal");
			const choice = await ctx.ui.select(t("learning.generationQuestion"), [allow, t("learning.notNow"), suppress]);
			if (choice === suppress) {
				await store.suppressSignal(signal.id, signal.scope);
				ctx.ui.notify(t("learning.suppressed"), "info");
				return;
			}
			if (choice !== allow) return;
			startGeneration(signal);
		});

		const runEvaluation = async (candidate: EvolutionCandidate, ctx: ExtensionCommandContext): Promise<void> => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify(t("agentEval.noModel"), "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(t("agentEval.uiRequired"), "warning");
				return;
			}
			const testCase = AGENT_EVAL_CASES.find((item) => item.id === candidate.evalCaseId);
			if (!testCase) {
				ctx.ui.notify(t("learning.invalidCase", { id: candidate.evalCaseId }), "error");
				return;
			}
			const approved = await ctx.ui.confirm(
				t("learning.evalConfirmTitle"),
				t("learning.evalConfirmBody", { title: candidate.title, case: testCase.title }),
			);
			if (!approved) return;
			const runScope = scope ?? projectScope(ctx.cwd);
			const prompts = await store.evaluationPrompts(candidate.id, runScope);
			const runOne = async (phase: string, appendSystemPrompt?: string) => {
				const startedAt = Date.now();
				let progress: AgentEvalProgress = { stage: "preparing", toolCalls: 0 };
				const render = (): void => {
					ctx.ui.setWidget?.("learning-eval-progress", progressLines(phase, testCase, progress, startedAt), {
						placement: "aboveEditor",
					});
				};
				render();
				const timer = setInterval(render, 1_000);
				try {
					return await runner.run(
						testCase,
						{
							provider: model.provider,
							model: model.id,
							thinkingLevel: ctx.thinkingLevel ?? "off",
							tools: pi.getActiveTools().filter((name) => name !== INTERNAL_TOOL),
							...(appendSystemPrompt ? { appendSystemPrompt } : {}),
							onProgress: (next) => {
								progress = next;
								render();
							},
						},
						ctx.signal,
					);
				} finally {
					clearInterval(timer);
					ctx.ui.setWidget?.("learning-eval-progress", undefined);
				}
			};
			ctx.ui.setStatus("learning-eval", t("learning.evalRunning"));
			try {
				const baselineResult = await runOne(t("learning.evalBaseline"), prompts.baselinePrompt);
				await resultStore.append(baselineResult);
				const candidateResult = await runOne(t("learning.evalCandidate"), prompts.candidatePrompt);
				await resultStore.append(candidateResult);
				const evaluated = await store.saveEvaluation(
					candidate.id,
					prompts.candidate.digest,
					baselineResult,
					candidateResult,
					runScope,
				);
				pi.appendEntry<AgentEvalReportEntryData>(AGENT_EVAL_REPORT_ENTRY, {
					version: 1,
					createdAt: now().toISOString(),
					results: [candidateResult],
					previousResults: [baselineResult],
					comparisonMode: "candidate",
				});
				ctx.ui.notify(
					evaluated.evaluations.at(-1)?.gatePassed ? t("learning.evalPassed") : t("learning.evalFailed"),
					evaluated.evaluations.at(-1)?.gatePassed ? "info" : "warning",
				);
			} finally {
				ctx.ui.setStatus("learning-eval", undefined);
			}
		};

		const showMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
			const runScope = scope ?? projectScope(ctx.cwd);
			const snapshot = await store.snapshot(runScope);
			cachedSnapshot = snapshot;
			const options = [t("learning.menuStatus")];
			const eligibleSignals = snapshot.signals.filter((signal) => signal.status === "eligible");
			const testable = snapshot.candidates.filter((candidate) =>
				new Set(["proposed", "evaluated", "failed"]).has(candidate.status),
			);
			const evaluated = snapshot.candidates.filter((candidate) => candidate.status === "evaluated");
			const promotable = snapshot.candidates.filter((candidate) => candidate.status === "awaiting_promotion");
			const rollbackable = snapshot.candidates.filter((candidate) =>
				new Set(["canary", "awaiting_promotion", "promoted"]).has(candidate.status),
			);
			if (eligibleSignals.length > 0) options.push(t("learning.menuGenerate", { count: eligibleSignals.length }));
			if (testable.length > 0) options.push(t("learning.menuTest", { count: testable.length }));
			if (evaluated.length > 0) options.push(t("learning.menuCanary", { count: evaluated.length }));
			if (promotable.length > 0) options.push(t("learning.menuPromote", { count: promotable.length }));
			if (rollbackable.length > 0) options.push(t("learning.menuRollback", { count: rollbackable.length }));
			if (snapshot.candidates.length > 0) options.push(t("learning.menuHistory"));
			options.push(snapshot.settings.enabled ? t("learning.menuPause") : t("learning.menuResume"));
			const choice = await ctx.ui.select(t("learning.menuTitle"), options);
			if (choice === t("learning.menuStatus")) {
				ctx.ui.notify(formatSnapshot(snapshot), "info");
				return;
			}
			if (choice === t("learning.menuGenerate", { count: eligibleSignals.length })) {
				const choices = eligibleSignals.map(
					(signal) => `${signal.id.slice(0, 8)} · ${signalSummary(signal).slice(0, 72)}`,
				);
				const selected = await ctx.ui.select(t("learning.chooseSignal"), choices);
				const index = selected === undefined ? -1 : choices.indexOf(selected);
				const signal = index < 0 ? undefined : eligibleSignals[index];
				if (signal) startGeneration(signal);
				return;
			}
			if (choice === t("learning.menuTest", { count: testable.length })) {
				const candidate = await chooseCandidate(testable, ctx, t("learning.chooseTest"));
				if (candidate) await runEvaluation(candidate, ctx);
				return;
			}
			if (choice === t("learning.menuCanary", { count: evaluated.length })) {
				const candidate = await chooseCandidate(evaluated, ctx, t("learning.chooseCanary"));
				if (!candidate) return;
				const approved = await ctx.ui.confirm(
					t("learning.canaryConfirmTitle"),
					`${candidatePreview(candidate)}\n\n${t("learning.canaryConfirmBody", { runs: snapshot.settings.canaryRuns })}`,
				);
				if (approved) {
					await store.startCanary(candidate.id, candidate.digest, runScope);
					cachedSnapshot = undefined;
					ctx.ui.notify(t("learning.canaryStarted", { runs: snapshot.settings.canaryRuns }), "info");
				}
				return;
			}
			if (choice === t("learning.menuPromote", { count: promotable.length })) {
				const candidate = await chooseCandidate(promotable, ctx, t("learning.choosePromote"));
				if (!candidate) return;
				if (await ctx.ui.confirm(t("learning.promoteConfirmTitle"), candidatePreview(candidate))) {
					await store.promote(candidate.id, candidate.digest, runScope);
					cachedSnapshot = undefined;
					ctx.ui.notify(t("learning.promoted"), "info");
				}
				return;
			}
			if (choice === t("learning.menuRollback", { count: rollbackable.length })) {
				const candidate = await chooseCandidate(rollbackable, ctx, t("learning.chooseRollback"));
				if (!candidate) return;
				if (await ctx.ui.confirm(t("learning.rollbackConfirmTitle"), candidatePreview(candidate))) {
					await store.rollback(candidate.id, runScope);
					cachedSnapshot = undefined;
					ctx.ui.notify(t("learning.rolledBack"), "info");
				}
				return;
			}
			if (choice === t("learning.menuHistory")) {
				const candidate = await chooseCandidate(
					[...snapshot.candidates].reverse(),
					ctx,
					t("learning.chooseHistory"),
				);
				if (candidate) ctx.ui.notify(formatCandidateHistory(candidate, snapshot), "info");
				return;
			}
			if (choice === t("learning.menuPause")) {
				await store.setEnabled(false);
				cachedSnapshot = undefined;
				ctx.ui.notify(t("learning.paused"), "info");
			}
			if (choice === t("learning.menuResume")) {
				await store.setEnabled(true);
				cachedSnapshot = undefined;
				ctx.ui.notify(t("learning.resumed"), "info");
			}
		};

		pi.registerCommand("learn", {
			description: t("learning.commandDescription"),
			handler: async (args, ctx) => {
				try {
					const operation = args.trim().toLowerCase();
					const runScope = scope ?? projectScope(ctx.cwd);
					if (!operation && ctx.hasUI) {
						await showMenu(ctx);
						return;
					}
					if (!operation || operation === "status") {
						ctx.ui.notify(formatSnapshot(await store.snapshot(runScope)), "info");
						return;
					}
					if (operation === "pause" || operation === "resume") {
						await store.setEnabled(operation === "resume");
						cachedSnapshot = undefined;
						ctx.ui.notify(operation === "resume" ? t("learning.resumed") : t("learning.paused"), "info");
						return;
					}
					ctx.ui.notify(t("learning.help"), "warning");
				} catch (error) {
					ctx.ui.notify(
						t("learning.operationFailed", { error: error instanceof Error ? error.message : String(error) }),
						"error",
					);
				}
			},
		});
	};
}

export default createLearningExtension();
