import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.ts";
import { t } from "../i18n/index.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~/${relativeToHome.replaceAll("\\", "/").replaceAll(sep, "/")}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		const compact = width < 64;
		const separator = theme.fg("dim", compact ? " " : " · ");
		const projectParts = [
			theme.fg(
				"muted",
				formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
			),
		];
		const branch = this.footerData.getGitBranch();
		if (branch) projectParts.push(`${theme.fg("dim", "git:")}${theme.fg("accent", branch)}`);
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) projectParts.push(theme.fg("text", sessionName));

		type FooterSegment = { text: string; priority: number; required?: boolean };
		const totalTokens = usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite;
		const segments: FooterSegment[] = [
			{
				text: compact
					? theme.fg("text", `Σ${formatTokens(totalTokens)}`)
					: `${theme.fg("dim", `${t("footer.total")} `)}${theme.fg("text", formatTokens(totalTokens))}`,
				priority: 110,
				required: true,
			},
		];
		if (usageTotals.input) {
			segments.push({ text: theme.fg("muted", `↑${formatTokens(usageTotals.input)}`), priority: 50 });
		}
		if (usageTotals.output) {
			segments.push({ text: theme.fg("accent", `↓${formatTokens(usageTotals.output)}`), priority: 60 });
		}
		if (usageTotals.cacheRead) {
			segments.push({ text: theme.fg("dim", `R${formatTokens(usageTotals.cacheRead)}`), priority: 20 });
		}
		if (usageTotals.cacheWrite) {
			segments.push({ text: theme.fg("dim", `W${formatTokens(usageTotals.cacheWrite)}`), priority: 10 });
		}
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			segments.push({ text: theme.fg("success", `CH${latestCacheHitRate.toFixed(1)}%`), priority: 30 });
		}

		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			const cost = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			segments.push({ text: theme.fg("warning", cost), priority: 70 });
		}

		const autoIndicator = this.autoCompactEnabled ? ` (${t("footer.auto")})` : "";
		const contextDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		const contextColor = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "success";
		segments.push({
			text: `${compact ? "" : theme.fg("dim", `${t("footer.context")} `)}${theme.fg(contextPercent === "?" ? "dim" : contextColor, contextDisplay)}`,
			priority: 100,
			required: true,
		});
		if (areExperimentalFeaturesEnabled()) {
			segments.push({ text: theme.bold(theme.fg("warning", "xp")), priority: 40 });
		}

		const modelName = state.model?.id || t("footer.noModel");
		let modelDisplay = theme.fg("accent", modelName);
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			const thinkingText = thinkingLevel === "off" ? t("footer.thinkingOff") : thinkingLevel;
			modelDisplay += `${theme.fg("dim", " • ")}${theme.getThinkingBorderColor(thinkingLevel)(thinkingText)}`;
		}
		const modelWithoutProvider = modelDisplay;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			modelDisplay = `${theme.fg("muted", `(${state.model.provider})`)} ${modelDisplay}`;
		}

		const minPadding = 2;
		const getLeft = () => segments.map((segment) => segment.text).join(separator);
		while (visibleWidth(getLeft()) + minPadding + visibleWidth(modelDisplay) > width) {
			let removableIndex = -1;
			for (let index = 0; index < segments.length; index++) {
				const segment = segments[index];
				if (segment.required) continue;
				if (
					removableIndex === -1 ||
					segment.priority < (segments[removableIndex]?.priority ?? Number.POSITIVE_INFINITY)
				) {
					removableIndex = index;
				}
			}
			if (removableIndex === -1) break;
			segments.splice(removableIndex, 1);
		}

		let statsLeft = getLeft();
		if (visibleWidth(statsLeft) + minPadding + visibleWidth(modelDisplay) > width)
			modelDisplay = modelWithoutProvider;
		if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width, "");
		const availableForModel = Math.max(0, width - visibleWidth(statsLeft) - minPadding);
		const fittedModel = truncateToWidth(modelDisplay, availableForModel, "");
		const padding = " ".repeat(Math.max(0, width - visibleWidth(statsLeft) - visibleWidth(fittedModel)));
		const statsLine = statsLeft + padding + fittedModel;

		const projectLine = truncateToWidth(projectParts.join(separator), width, theme.fg("dim", "..."));
		const lines = [projectLine, statsLine];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
