import path from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { runInfrastructureSmoke } from "./cases.ts";
import { formatEvalComparison, formatEvalFailures, formatEvalReport } from "./report.ts";
import { compareEvalReports } from "./scorer.ts";
import { EvalReportStore } from "./store.ts";
import type { EvalReportStoreLike } from "./types.ts";

const HELP = "用法：/evals run | latest | baseline | compare | failures";

export function createEvalsExtension(
	store: EvalReportStoreLike,
	now: () => Date = () => new Date(),
): (pi: ExtensionAPI) => void {
	return (pi) => {
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
