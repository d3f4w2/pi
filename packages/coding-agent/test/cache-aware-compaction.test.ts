import { describe, expect, it } from "vitest";
import { decideCacheAwareCompactionDeferral } from "../src/core/cache-aware-compaction.ts";
import type { PromptCacheRuntimeSnapshot } from "../src/core/prompt-cache-runtime.ts";

function warmSnapshot(overrides: Partial<PromptCacheRuntimeSnapshot> = {}): PromptCacheRuntimeSnapshot {
	return {
		requests: 4,
		responses: 4,
		promptTokens: 100_000,
		cacheReadTokens: 80_000,
		cacheWriteTokens: 0,
		actualCacheReadRate: 0.8,
		lastResponseCacheReadRate: 0.9,
		exactPrefixBytes: 100_000,
		comparableInputBytes: 120_000,
		exactPrefixByteRate: 0.83,
		estimatedSavingsUsd: 0.1,
		changeCounts: {},
		breakpointDecisions: {},
		compactionDeferrals: 0,
		continuationAttempts: 0,
		continuationSuccesses: 0,
		continuationFallbacks: 0,
		lastResponseAt: 1_000,
		...overrides,
	};
}

describe("cache-aware threshold compaction", () => {
	it("defers one warm threshold crossing when hard output headroom remains", () => {
		const decision = decideCacheAwareCompactionDeferral({
			contextTokens: 113_000,
			contextWindow: 128_000,
			reserveTokens: 16_384,
			maxOutputTokens: 4_096,
			alreadyDeferred: false,
			report: warmSnapshot(),
			now: 2_000,
		});

		expect(decision).toEqual({ defer: true, reason: "warm-cache-grace" });
	});

	it("never defers twice or inside the hard output margin", () => {
		const base = {
			contextTokens: 113_000,
			contextWindow: 128_000,
			reserveTokens: 16_384,
			maxOutputTokens: 4_096,
			report: warmSnapshot(),
			now: 2_000,
		};
		expect(decideCacheAwareCompactionDeferral({ ...base, alreadyDeferred: true }).defer).toBe(false);
		expect(
			decideCacheAwareCompactionDeferral({ ...base, contextTokens: 124_500, alreadyDeferred: false }).defer,
		).toBe(false);
	});

	it("requires recent measured provider cache reuse", () => {
		const base = {
			contextTokens: 113_000,
			contextWindow: 128_000,
			reserveTokens: 16_384,
			maxOutputTokens: 4_096,
			alreadyDeferred: false,
			now: 400_000,
		};
		expect(
			decideCacheAwareCompactionDeferral({
				...base,
				report: warmSnapshot({ lastResponseCacheReadRate: 0.1 }),
			}).defer,
		).toBe(false);
		expect(
			decideCacheAwareCompactionDeferral({ ...base, report: warmSnapshot({ lastResponseAt: 1_000 }) }).defer,
		).toBe(false);
	});
});
