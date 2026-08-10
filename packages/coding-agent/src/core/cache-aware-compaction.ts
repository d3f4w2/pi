import { CACHE_TTL_MS } from "./cache-stats.ts";
import type { PromptCacheRuntimeSnapshot } from "./prompt-cache-runtime.ts";

export type CacheAwareCompactionReason =
	| "warm-cache-grace"
	| "already-deferred"
	| "cache-cold"
	| "cache-stale"
	| "hard-output-margin"
	| "grace-exceeded";

export interface CacheAwareCompactionDecision {
	defer: boolean;
	reason: CacheAwareCompactionReason;
}

export interface CacheAwareCompactionInput {
	contextTokens: number;
	contextWindow: number;
	reserveTokens: number;
	maxOutputTokens: number;
	alreadyDeferred: boolean;
	report: PromptCacheRuntimeSnapshot | undefined;
	now?: number;
}

/**
 * Preserve a warm cache for one extra turn only inside a bounded grace band.
 * Overflow recovery and manual compaction do not call this policy.
 */
export function decideCacheAwareCompactionDeferral(input: CacheAwareCompactionInput): CacheAwareCompactionDecision {
	if (input.alreadyDeferred) return { defer: false, reason: "already-deferred" };
	const report = input.report;
	if (!report || report.responses < 2 || report.lastResponseCacheReadRate < 0.5) {
		return { defer: false, reason: "cache-cold" };
	}
	const now = input.now ?? Date.now();
	if (report.lastResponseAt === undefined || now - report.lastResponseAt >= CACHE_TTL_MS) {
		return { defer: false, reason: "cache-stale" };
	}

	const remainingTokens = input.contextWindow - input.contextTokens;
	// The model catalog maximum can be much larger than the configured compaction
	// reserve. Bound the projected next answer to one quarter of that reserve.
	const projectedOutputTokens = Math.min(input.maxOutputTokens, Math.max(2_048, Math.floor(input.reserveTokens / 4)));
	const hardOutputMargin = Math.max(4_096, projectedOutputTokens * 2);
	if (remainingTokens < hardOutputMargin) return { defer: false, reason: "hard-output-margin" };

	const threshold = input.contextWindow - input.reserveTokens;
	const thresholdOverrun = Math.max(0, input.contextTokens - threshold);
	if (thresholdOverrun > Math.min(8_192, Math.floor(input.reserveTokens / 4))) {
		return { defer: false, reason: "grace-exceeded" };
	}
	return { defer: true, reason: "warm-cache-grace" };
}
