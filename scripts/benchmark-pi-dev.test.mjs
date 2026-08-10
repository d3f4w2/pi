import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compare, percentile, summarize } from "./benchmark-pi-dev.mjs";

describe("pi-dev benchmark statistics", () => {
	it("calculates nearest-rank percentiles", () => {
		assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
		assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
	});

	it("summarizes even-sized samples", () => {
		assert.deepEqual(summarize([40, 10, 30, 20]), {
			runs: 4,
			minMs: 10,
			medianMs: 25,
			avgMs: 25,
			p95Ms: 40,
			maxMs: 40,
		});
	});

	it("reports saved time, percent improvement, and speedup", () => {
		assert.deepEqual(
			compare(
				{ medianMs: 200, p95Ms: 250 },
				{ medianMs: 100, p95Ms: 150 },
			),
			{
				medianSavedMs: 100,
				medianImprovementPercent: 50,
				medianSpeedup: 2,
				p95SavedMs: 100,
				p95ImprovementPercent: 40,
			},
		);
	});
});
