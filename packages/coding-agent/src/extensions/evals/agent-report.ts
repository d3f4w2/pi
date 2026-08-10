import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { t } from "../../modes/interactive/i18n/index.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentEvalResult, AgentEvalTraceEntry } from "./types.ts";

export const AGENT_EVAL_REPORT_ENTRY = "agent-eval-report";

export interface AgentEvalReportEntryData {
	version: 1;
	createdAt: string;
	results: AgentEvalResult[];
	previousResults?: AgentEvalResult[];
	comparisonUnavailable?: boolean;
	comparisonMode?: "history" | "candidate";
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
	return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function traceLabel(entry: AgentEvalTraceEntry): string {
	if (entry.kind === "tool") return entry.name;
	if (
		entry.name === "preparing" ||
		entry.name === "starting" ||
		entry.name === "working" ||
		entry.name === "verifying" ||
		entry.name === "cleanup"
	) {
		return t(`agentEval.stage.${entry.name}`);
	}
	return entry.name;
}

function statusGlyph(entry: AgentEvalTraceEntry, theme: Theme): string {
	if (entry.status === "passed") return theme.fg("success", "✓");
	if (entry.status === "failed") return theme.fg("error", "✗");
	return theme.fg("warning", "·");
}

function resultOutcome(result: AgentEvalResult): string {
	if (result.passed) return t("agentEval.reportPassed");
	if (result.verificationPassed && result.budgetPassed === false) return t("agentEval.reportOverBudget");
	return t("agentEval.reportFailed");
}

function outcomeColor(result: AgentEvalResult, text: string, theme: Theme): string {
	if (result.passed) return theme.fg("success", text);
	if (result.verificationPassed && result.budgetPassed === false) return theme.fg("warning", text);
	return theme.fg("error", text);
}

function formatTrace(result: AgentEvalResult, theme: Theme): string[] {
	if (!result.trace || result.trace.length === 0) return [theme.fg("dim", t("agentEval.reportLegacy"))];
	const lines: string[] = [];
	for (const entry of [...result.trace].sort((a, b) => a.startedAtMs - b.startedAtMs)) {
		lines.push(
			`${theme.fg("dim", formatDuration(entry.startedAtMs).padStart(6))}  ${statusGlyph(entry, theme)} ${traceLabel(entry)} ${theme.fg("dim", formatDuration(entry.durationMs))}`,
		);
		if (entry.input) lines.push(`          ${theme.fg("muted", t("agentEval.reportInput"))} ${entry.input}`);
		if (entry.output) lines.push(`          ${theme.fg("muted", t("agentEval.reportOutput"))} ${entry.output}`);
	}
	return lines;
}

function formatTiming(result: AgentEvalResult): string {
	const timing = result.timing;
	if (!timing) return t("agentEval.reportTotalLatency", { total: formatDuration(result.durationMs) });
	return t("agentEval.reportTiming", {
		preparing: formatDuration(timing.preparingMs),
		startup: formatDuration(timing.startupMs),
		agent: formatDuration(timing.agentMs),
		verification: formatDuration(timing.verificationMs),
		cleanup: formatDuration(timing.cleanupMs),
		total: formatDuration(result.durationMs),
	});
}

function formatConsumption(result: AgentEvalResult): string {
	return t("agentEval.reportTokens", {
		total: formatTokens(result.totalTokens),
		input: formatTokens(result.inputTokens ?? 0),
		output: formatTokens(result.outputTokens ?? 0),
		cache: formatTokens(result.cacheReadTokens ?? 0),
		tools: result.toolCalls,
		errors: result.toolErrors,
	});
}

function judgement(value: boolean | undefined): string {
	if (value === undefined) return t("agentEval.reportUnknown");
	return value ? t("agentEval.reportPass") : t("agentEval.reportFail");
}

function signedNumber(value: number, formatter: (absolute: number) => string): string {
	if (value === 0) return "0";
	return `${value > 0 ? "+" : "-"}${formatter(Math.abs(value))}`;
}

function toolCounts(result: AgentEvalResult): Map<string, number> | undefined {
	if (!result.trace) return undefined;
	const counts = new Map<string, number>();
	for (const entry of result.trace) {
		if (entry.kind === "tool") counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
	}
	return counts;
}

function formatToolUse(
	counts: ReadonlyMap<string, number> | undefined,
	toolNames: readonly string[],
	previousCounts?: ReadonlyMap<string, number>,
): string {
	if (!counts) return t("agentEval.reportChainUnavailable");
	const parts = toolNames.flatMap((name) => {
		const count = counts.get(name) ?? 0;
		const delta = previousCounts ? count - (previousCounts.get(name) ?? 0) : 0;
		if (count === 0 && delta === 0) return [];
		return [`${name}×${count}${delta === 0 ? "" : `(${delta > 0 ? "+" : ""}${delta})`}`];
	});
	return parts.length > 0 ? parts.join(" · ") : t("agentEval.reportNoTools");
}

function formatToolComparison(previous: AgentEvalResult, current: AgentEvalResult): string[] {
	const previousCounts = toolCounts(previous);
	const currentCounts = toolCounts(current);
	const toolNames = [...new Set([...(previousCounts?.keys() ?? []), ...(currentCounts?.keys() ?? [])])];
	return [
		t("agentEval.reportCompareToolsPrevious", {
			total: previous.toolCalls,
			tools: formatToolUse(previousCounts, toolNames),
		}),
		t("agentEval.reportCompareToolsCurrent", {
			total: current.toolCalls,
			tools: formatToolUse(currentCounts, toolNames, previousCounts),
		}),
	];
}

function formatComparison(
	current: AgentEvalResult,
	previous: AgentEvalResult | undefined,
	theme: Theme,
	unavailable: boolean,
	mode: AgentEvalReportEntryData["comparisonMode"],
): string[] {
	if (unavailable) return [theme.fg("warning", t("agentEval.reportComparisonUnavailable"))];
	if (!previous) return [theme.fg("dim", t("agentEval.reportFirstRun"))];
	const previousConfig = `${previous.provider}/${previous.model} · ${previous.thinkingLevel}`;
	const currentConfig = `${current.provider}/${current.model} · ${current.thinkingLevel}`;
	const sameConfig = previousConfig === currentConfig;
	return [
		theme.fg("dim", mode === "candidate" ? t("learning.evalComparisonNote") : t("agentEval.reportNeutralComparison")),
		t("agentEval.reportCompareOutcome", { previous: resultOutcome(previous), current: resultOutcome(current) }),
		sameConfig
			? t("agentEval.reportCompareConfigSame", { config: currentConfig })
			: t("agentEval.reportCompareConfigChanged", { previous: previousConfig, current: currentConfig }),
		t("agentEval.reportCompareDuration", {
			previous: formatDuration(previous.durationMs),
			current: formatDuration(current.durationMs),
			delta: signedNumber(current.durationMs - previous.durationMs, formatDuration),
		}),
		t("agentEval.reportCompareOutput", {
			previous: formatTokens(previous.outputTokens ?? 0),
			current: formatTokens(current.outputTokens ?? 0),
			delta: signedNumber((current.outputTokens ?? 0) - (previous.outputTokens ?? 0), formatTokens),
		}),
		t("agentEval.reportCompareTotal", {
			previous: formatTokens(previous.totalTokens),
			current: formatTokens(current.totalTokens),
			delta: signedNumber(current.totalTokens - previous.totalTokens, formatTokens),
		}),
		...formatToolComparison(previous, current),
		t("agentEval.reportCompareErrors", {
			previous: previous.toolErrors,
			current: current.toolErrors,
			delta: signedNumber(current.toolErrors - previous.toolErrors, String),
		}),
	];
}

function formatResultDetails(
	result: AgentEvalResult,
	previous: AgentEvalResult | undefined,
	theme: Theme,
	comparisonUnavailable: boolean,
	comparisonMode: AgentEvalReportEntryData["comparisonMode"],
): string {
	const lines = [
		`${outcomeColor(result, resultOutcome(result), theme)}  ${theme.fg("accent", result.title)}`,
		theme.fg(
			"dim",
			t("agentEval.model", { provider: result.provider, model: result.model, thinking: result.thinkingLevel }),
		),
		"",
		theme.fg("accent", t("agentEval.reportComparison")),
		...formatComparison(result, previous, theme, comparisonUnavailable, comparisonMode),
		"",
		theme.fg("accent", t("agentEval.reportChain")),
		...formatTrace(result, theme),
	];
	if (result.assistantSummary) {
		lines.push("", theme.fg("accent", t("agentEval.reportAnswer")), result.assistantSummary);
	}
	lines.push(
		"",
		theme.fg("accent", t("agentEval.reportLatency")),
		formatTiming(result),
		"",
		theme.fg("accent", t("agentEval.reportConsumption")),
		formatConsumption(result),
		"",
		theme.fg("accent", t("agentEval.reportJudgement")),
		t("agentEval.reportJudgementLine", {
			verification: judgement(result.verificationPassed),
			budget: judgement(result.budgetPassed),
		}),
	);
	if (result.failure) lines.push(theme.fg("error", t("agentEval.reason", { reason: result.failure })));
	return lines.join("\n");
}

export function createAgentEvalReportComponent(
	data: AgentEvalReportEntryData,
	expanded: boolean,
	theme: Theme,
): Component {
	const passed = data.results.filter((result) => result.passed).length;
	const duration = data.results.reduce((total, result) => total + result.durationMs, 0);
	const tokens = data.results.reduce((total, result) => total + result.totalTokens, 0);
	const tools = data.results.reduce((total, result) => total + result.toolCalls, 0);
	const summary = t("agentEval.reportSummary", {
		passed,
		total: data.results.length,
		duration: formatDuration(duration),
		tokens: formatTokens(tokens),
		tools,
	});
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const title = `${theme.fg("accent", "›")} ${theme.bold(t("agentEval.reportTitle"))} · ${
		passed === data.results.length ? theme.fg("success", summary) : theme.fg("warning", summary)
	}`;
	box.addChild(
		new Text(
			expanded
				? `${title}  ${theme.fg("dim", t("agentEval.reportCollapse"))}\n\n${data.results
						.map((result) =>
							formatResultDetails(
								result,
								data.previousResults?.find((previous) => previous.caseId === result.caseId),
								theme,
								data.comparisonUnavailable === true,
								data.comparisonMode,
							),
						)
						.join("\n\n")}`
				: `${title}  ${theme.fg("dim", t("agentEval.reportExpand"))}`,
			0,
			0,
		),
	);
	return box;
}
