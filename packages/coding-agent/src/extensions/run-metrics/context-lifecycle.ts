import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../../core/compaction/compaction.ts";

export interface ContextLifecycleMetrics {
	activeMessagesBefore: number;
	activeMessagesAfter: number;
	messagesRemoved: number;
	estimatedInputTokensBefore: number;
	estimatedInputTokensAfter: number;
	estimatedTokensRemoved: number;
	tokenReductionPercent: number;
	reportGenerationMs: number;
	restoreDurationMs?: number;
	promptCacheReusablePrefixMessages: number;
	promptCacheReusablePrefixTokens: number;
	promptCacheInvalidatedSuffixTokens: number;
	deterministicEvidenceTotal: number;
	deterministicEvidenceRetained: number;
	deterministicEvidenceOmitted: boolean;
	deterministicEvidenceRetentionPercent: number;
	userMessagesTotal: number;
	userMessagesRetained: number;
	userMessageRetentionPercent: number;
	recoverable: boolean;
}

export interface CalculateContextLifecycleMetricsInput {
	before: readonly AgentMessage[];
	after: readonly AgentMessage[];
	deterministicEvidenceIds: readonly string[];
	retainedEvidenceIds: readonly string[];
	userMessageIds: readonly string[];
	retainedUserMessageIds: readonly string[];
	reportGenerationMs: number;
	recoverable: boolean;
}

function estimatedTokens(messages: readonly AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function exactMessagePrefixLength(before: readonly AgentMessage[], after: readonly AgentMessage[]): number {
	const length = Math.min(before.length, after.length);
	let index = 0;
	while (index < length && JSON.stringify(before[index]) === JSON.stringify(after[index])) index++;
	return index;
}

function retainedCount(expected: readonly string[], retained: readonly string[]): number {
	const retainedSet = new Set(retained);
	return new Set(expected).size === 0
		? 0
		: [...new Set(expected)].filter((evidenceId) => retainedSet.has(evidenceId)).length;
}

function percent(numerator: number, denominator: number): number {
	return denominator === 0 ? 100 : (numerator / denominator) * 100;
}

export function calculateContextLifecycleMetrics(
	input: CalculateContextLifecycleMetricsInput,
): ContextLifecycleMetrics {
	const beforeTokens = estimatedTokens(input.before);
	const afterTokens = estimatedTokens(input.after);
	const reusablePrefixMessages = exactMessagePrefixLength(input.before, input.after);
	const reusablePrefixTokens = estimatedTokens(input.before.slice(0, reusablePrefixMessages));
	const evidenceTotal = new Set(input.deterministicEvidenceIds).size;
	const evidenceRetained = retainedCount(input.deterministicEvidenceIds, input.retainedEvidenceIds);
	const userMessagesTotal = new Set(input.userMessageIds).size;
	const userMessagesRetained = retainedCount(input.userMessageIds, input.retainedUserMessageIds);

	return {
		activeMessagesBefore: input.before.length,
		activeMessagesAfter: input.after.length,
		messagesRemoved: Math.max(0, input.before.length - reusablePrefixMessages),
		estimatedInputTokensBefore: beforeTokens,
		estimatedInputTokensAfter: afterTokens,
		estimatedTokensRemoved: Math.max(0, beforeTokens - afterTokens),
		tokenReductionPercent: percent(Math.max(0, beforeTokens - afterTokens), beforeTokens),
		reportGenerationMs: Math.max(0, input.reportGenerationMs),
		promptCacheReusablePrefixMessages: reusablePrefixMessages,
		promptCacheReusablePrefixTokens: reusablePrefixTokens,
		promptCacheInvalidatedSuffixTokens: Math.max(0, beforeTokens - reusablePrefixTokens),
		deterministicEvidenceTotal: evidenceTotal,
		deterministicEvidenceRetained: evidenceRetained,
		deterministicEvidenceOmitted: evidenceRetained !== evidenceTotal,
		deterministicEvidenceRetentionPercent: percent(evidenceRetained, evidenceTotal),
		userMessagesTotal,
		userMessagesRetained,
		userMessageRetentionPercent: percent(userMessagesRetained, userMessagesTotal),
		recoverable: input.recoverable,
	};
}
