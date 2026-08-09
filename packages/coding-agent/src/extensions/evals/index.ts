import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { t } from "../../modes/interactive/i18n/index.ts";
import { runInfrastructureSmoke } from "./cases.ts";
import { RecoveredFailureTracker } from "./failure-tracker.ts";
import {
	formatRegressionDraftPreview,
	RegressionCaseStore,
	RegressionCaseWriter,
	validateRegressionDraft,
} from "./regression-cases.ts";
import { formatEvalComparison, formatEvalFailures, formatEvalReport } from "./report.ts";
import { compareEvalReports } from "./scorer.ts";
import { EvalReportStore } from "./store.ts";
import type {
	EvalReportStoreLike,
	RecoveredFailureSignal,
	RegressionCaseStoreLike,
	RegressionCaseWriterLike,
} from "./types.ts";

const HELP = "用法：/evals run | latest | baseline | compare | failures";
const GRANT_TTL_MS = 5 * 60 * 1000;
const INTERNAL_TOOL = "eval_case";

const EvalCaseParams = Type.Object(
	{
		grantId: Type.String({ minLength: 1, maxLength: 100, description: "用户首次批准后返回的一次性授权 ID" }),
		title: Type.String({ minLength: 1, maxLength: 120, description: "简短的回归测试标题" }),
		category: Type.Union([
			Type.Literal("navigation"),
			Type.Literal("editing"),
			Type.Literal("verification"),
			Type.Literal("testing"),
			Type.Literal("web"),
			Type.Literal("process"),
			Type.Literal("browser"),
			Type.Literal("debugging"),
			Type.Literal("fallback"),
		]),
		reproduction: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 6 }),
		expectedFailure: Type.String({ minLength: 1, maxLength: 500, description: "修复前能观察到的失败" }),
		expectedSuccess: Type.String({ minLength: 1, maxLength: 500, description: "修复后能观察到的结果" }),
		files: Type.Array(
			Type.Object(
				{
					path: Type.String({ minLength: 1, maxLength: 200, description: "项目内的新测试文件相对路径" }),
					content: Type.String({ minLength: 1, maxLength: 4_000, description: "完整测试文件内容" }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 2 },
		),
	},
	{ additionalProperties: false },
);

interface GenerationGrant {
	id: string;
	source: RecoveredFailureSignal;
	cwd: string;
	expiresAt: number;
}

function localizedFailureSummary(signal: RecoveredFailureSignal): string {
	if (signal.kind === "verification_failure") return t("evalCapture.summaryVerification");
	if (signal.kind === "agent_error") return t("evalCapture.summaryAgent");
	return t("evalCapture.summaryTool", { tool: signal.toolName ?? "unknown" });
}

export function createEvalsExtension(
	store: EvalReportStoreLike,
	now: () => Date = () => new Date(),
	regressionStore: RegressionCaseStoreLike = new RegressionCaseStore(path.join(getAgentDir(), "evals")),
	regressionWriter: RegressionCaseWriterLike = new RegressionCaseWriter(regressionStore),
): (pi: ExtensionAPI) => void {
	return (pi) => {
		const failureTracker = new RecoveredFailureTracker();
		let pendingSignal: RecoveredFailureSignal | undefined;
		let grant: GenerationGrant | undefined;
		let generationRun = false;
		let unusedGrant = false;

		const deactivateInternalTool = (): void => {
			const active = pi.getActiveTools();
			if (active.includes(INTERNAL_TOOL)) pi.setActiveTools(active.filter((name) => name !== INTERNAL_TOOL));
		};
		const revokeGrant = (): void => {
			grant = undefined;
			deactivateInternalTool();
		};

		pi.registerTool<typeof EvalCaseParams, { status: "approved" | "rejected" | "denied"; caseId?: string }>({
			name: INTERNAL_TOOL,
			label: t("evalCapture.toolLabel"),
			description: t("evalCapture.toolDescription"),
			parameters: EvalCaseParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const activeGrant = grant;
				if (!activeGrant || params.grantId !== activeGrant.id || now().getTime() > activeGrant.expiresAt) {
					revokeGrant();
					return {
						content: [{ type: "text", text: t("evalCapture.noGrant") }],
						details: { status: "denied" },
					};
				}
				try {
					const draft = validateRegressionDraft({
						title: params.title,
						category: params.category,
						reproduction: [...params.reproduction],
						expectedFailure: params.expectedFailure,
						expectedSuccess: params.expectedSuccess,
						files: params.files.map((file) => ({ ...file })),
					});
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: t("evalCapture.noSecondApproval") }],
							details: { status: "denied" },
						};
					}
					const approved = await ctx.ui.confirm(
						t("evalCapture.reviewTitle"),
						formatRegressionDraftPreview(
							draft,
							activeGrant.source,
							{
								source: t("evalCapture.previewSource"),
								title: t("evalCapture.previewTitle"),
								category: t("evalCapture.previewCategory"),
								expectedFailure: t("evalCapture.previewFailure"),
								expectedSuccess: t("evalCapture.previewSuccess"),
								reproduction: t("evalCapture.previewReproduction"),
								file: t("evalCapture.previewFile"),
							},
							localizedFailureSummary(activeGrant.source),
						),
					);
					if (!approved) {
						return {
							content: [{ type: "text", text: t("evalCapture.secondRejected") }],
							details: { status: "rejected" },
						};
					}
					const testCase = await regressionWriter.write(activeGrant.cwd, draft, activeGrant.source, now());
					return {
						content: [
							{
								type: "text",
								text: t("evalCapture.added", {
									id: testCase.id,
									files: testCase.files.map((file) => file.path).join(", "),
								}),
							},
						],
						details: { status: "approved", caseId: testCase.id },
					};
				} finally {
					revokeGrant();
				}
			},
		});
		deactivateInternalTool();

		pi.on("agent_start", () => {
			if (grant) {
				generationRun = true;
				return;
			}
			generationRun = false;
			failureTracker.start(now().getTime());
		});
		pi.on("tool_call", (event) => {
			if (!grant || event.toolName === INTERNAL_TOOL) return undefined;
			return { block: true, reason: t("evalCapture.blockedTool") };
		});
		pi.on("tool_result", (event) => {
			if (!generationRun) failureTracker.recordTool(event, now().getTime());
		});
		pi.on("turn_end", (event) => {
			if (!generationRun && event.message.role === "assistant") failureTracker.recordTurn(event.message.stopReason);
		});
		pi.on("agent_end", () => {
			if (generationRun) {
				generationRun = false;
				if (grant) {
					unusedGrant = true;
					revokeGrant();
				}
				return;
			}
			pendingSignal = failureTracker.finish(now().getTime());
		});
		pi.on("agent_settled", async (_event, ctx) => {
			if (unusedGrant) {
				unusedGrant = false;
				ctx.ui.notify(t("evalCapture.unusedGrant"), "warning");
				return;
			}
			const signal = pendingSignal;
			pendingSignal = undefined;
			if (!signal || !ctx.hasUI || grant) return;
			try {
				if (await regressionStore.isSuppressed(signal.fingerprint)) return;
			} catch (error) {
				ctx.ui.notify(
					t("evalCapture.preferenceError", { error: error instanceof Error ? error.message : String(error) }),
					"warning",
				);
				return;
			}
			const failureSummary = localizedFailureSummary(signal);
			ctx.ui.notify(t("evalCapture.detected", { summary: failureSummary }), "info");
			const allowChoice = t("evalCapture.allow");
			const suppressChoice = t("evalCapture.suppress");
			const choice = await ctx.ui.select(t("evalCapture.question"), [
				allowChoice,
				t("evalCapture.reject"),
				suppressChoice,
			]);
			if (choice === suppressChoice) {
				await regressionStore.suppress(signal.fingerprint);
				ctx.ui.notify(t("evalCapture.suppressed"), "info");
				return;
			}
			if (choice !== allowChoice) {
				ctx.ui.notify(t("evalCapture.declined"), "info");
				return;
			}
			grant = {
				id: randomUUID(),
				source: signal,
				cwd: ctx.cwd,
				expiresAt: now().getTime() + GRANT_TTL_MS,
			};
			const active = pi.getActiveTools();
			if (!active.includes(INTERNAL_TOOL)) pi.setActiveTools([...active, INTERNAL_TOOL]);
			pi.sendUserMessage(t("evalCapture.agentInstruction", { grantId: grant.id, summary: failureSummary }), {
				deliverAs: "followUp",
			});
		});

		pi.registerCommand("evals", {
			description: "运行本地评测并与基线比较",
			handler: async (args, ctx) => {
				const operation = args.trim().toLowerCase() || "latest";
				try {
					if (operation === "run") {
						const report = runInfrastructureSmoke(now());
						await store.append(report);
						ctx.ui.notify(formatEvalReport(report), report.summary.failed === 0 ? "info" : "warning");
						return;
					}
					const reports = await store.read();
					const latest = reports.at(-1);
					if (operation === "latest") {
						ctx.ui.notify(latest ? formatEvalReport(latest) : `还没有评测报告。\n${HELP}`, "info");
						return;
					}
					if (operation === "baseline") {
						if (!latest) {
							ctx.ui.notify(`还没有可保存的报告。先运行 /evals run。`, "warning");
							return;
						}
						await store.saveBaseline(latest);
						ctx.ui.notify(`已保存本地基线：${latest.id}`, "info");
						return;
					}
					if (operation === "compare") {
						const baseline = await store.readBaseline();
						if (!baseline || !latest) {
							ctx.ui.notify("缺少基线或候选报告。先运行 /evals run，再运行 /evals baseline。", "warning");
							return;
						}
						const comparison = compareEvalReports(baseline, latest);
						ctx.ui.notify(formatEvalComparison(comparison), comparison.passed ? "info" : "warning");
						return;
					}
					if (operation === "failures") {
						ctx.ui.notify(latest ? formatEvalFailures(latest) : "还没有评测报告。", "info");
						return;
					}
					ctx.ui.notify(HELP, "warning");
				} catch (error) {
					ctx.ui.notify(`评测操作失败：${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});
	};
}

export default createEvalsExtension(new EvalReportStore(path.join(getAgentDir(), "evals")));
