import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyOfficialResearchQuery, type OfficialSourceKind } from "../src/extensions/web/research.ts";
import { formatSearchMetadata, formatSearchResults, searchWeb } from "../src/extensions/web/search.ts";

const QUESTIONS: ReadonlyArray<readonly [string, OfficialSourceKind]> = [
	["github openai/openai-node pull 123", "github"],
	["gitlab gitlab-org/gitlab", "gitlab"],
	["npm package @types/node", "npm"],
	["pypi package requests", "pypi"],
	["crate serde", "crates"],
	["go package golang.org/x/net", "go-package"],
	["arxiv 2401.01234", "arxiv"],
	["OSV GHSA-xxxx-yyyy-zzzz", "osv"],
	["CVE-2024-3094", "nvd"],
	["CISA KEV CVE-2024-3094", "cisa-kev"],
];

function estimatedTokens(value: string): number {
	return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

describe("Research Engine 2.0", () => {
	afterEach(() => vi.unstubAllEnvs());

	test("verifies ten representative questions against an official source on the first hit", async () => {
		const measurements: Array<{
			query: string;
			officialFirstHit: boolean;
			toolCalls: number;
			latencyMs: number;
			estimatedInputTokens: number;
		}> = [];
		for (const [query, expectedKind] of QUESTIONS) {
			const startedAt = performance.now();
			let verifierCalls = 0;
			const result = await searchWeb(
				{ query },
				{
					verifyOfficialHit: async (hit) => {
						verifierCalls++;
						expect(hit.kind).toBe(expectedKind);
						return { cached: false };
					},
				},
			);
			const latencyMs = performance.now() - startedAt;
			expect(verifierCalls).toBe(1);
			expect(result.details).toMatchObject({
				provider: "official",
				officialSourceFirstHit: true,
				officialSourceVerified: true,
			});
			measurements.push({
				query,
				officialFirstHit: result.details.officialSourceVerified === true,
				toolCalls: 1,
				latencyMs,
				estimatedInputTokens: estimatedTokens(result.text),
			});
		}
		const sortedLatency = measurements
			.map((measurement) => measurement.latencyMs)
			.sort((left, right) => left - right);
		const genericMetadata = formatSearchMetadata({
			provider: "duckduckgo",
			query: "representative generic query",
			resultCount: 8,
			durationMs: 0,
			officialSourceFirstHit: false,
			sourceAddress: "https://html.duckduckgo.com/html/",
			strategy: "generic-search",
			readAt: "2026-08-10T00:00:00.000Z",
			contentType: "application/vnd.pi.search-results+text",
			cached: false,
			truncated: true,
			untrusted: true,
		});
		const genericResults = formatSearchResults(
			"representative generic query",
			Array.from({ length: 8 }, (_, index) => ({
				title: `Generic result ${index + 1}`,
				url: `https://result-${index + 1}.example.test/reference`,
				snippet:
					"A fixed generic-search snippet containing enough context to compare model-facing tool-result size.",
			})),
		);
		const genericBaselineTokens = estimatedTokens(`${genericMetadata}\n${genericResults}`);
		const meanEstimatedInputTokens =
			measurements.reduce((total, measurement) => total + measurement.estimatedInputTokens, 0) / measurements.length;
		const summary = {
			questions: measurements.length,
			officialFirstHitRate:
				measurements.filter((measurement) => measurement.officialFirstHit).length / measurements.length,
			meanToolCalls:
				measurements.reduce((total, measurement) => total + measurement.toolCalls, 0) / measurements.length,
			p50LatencyMs: sortedLatency[Math.floor(sortedLatency.length * 0.5)] ?? 0,
			p95LatencyMs: sortedLatency[Math.floor(sortedLatency.length * 0.95)] ?? 0,
			meanEstimatedInputTokens,
			genericSearchResultBaselineTokens: genericBaselineTokens,
			estimatedInputTokenReduction: 1 - meanEstimatedInputTokens / genericBaselineTokens,
		};

		expect(summary.officialFirstHitRate).toBeGreaterThanOrEqual(0.8);
		expect(summary.meanToolCalls).toBeLessThanOrEqual(3);
		console.info("RESEARCH_ENGINE_2_METRICS", JSON.stringify({ summary, measurements }));
	});

	test("recognizes structured documentation and question URLs without guessing generic queries", () => {
		expect(
			classifyOfficialResearchQuery(
				"https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster",
			),
		).toMatchObject({ kind: "stackoverflow" });
		expect(
			classifyOfficialResearchQuery(
				"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array",
			),
		).toMatchObject({ kind: "mdn" });
		expect(classifyOfficialResearchQuery("https://docs.rs/serde/latest/serde/")).toMatchObject({ kind: "docs-rs" });
		expect(classifyOfficialResearchQuery("https://requests.readthedocs.io/en/latest/")).toMatchObject({
			kind: "read-the-docs",
		});
		expect(classifyOfficialResearchQuery("best editor for a new programmer")).toBeUndefined();
	});

	test("returns a direct official result without requiring an API key", async () => {
		const result = await searchWeb(
			{ query: "npm package react" },
			{ verifyOfficialHit: async () => ({ cached: false }) },
		);
		expect(result.details).toMatchObject({
			provider: "official",
			officialSourceFirstHit: true,
			officialSourceVerified: true,
			strategy: "official-direct",
			sourceAddress: "npm://react",
			resultCount: 1,
		});
		expect(result.text).toContain("https://www.npmjs.com/package/react");
	});

	test("does not count a classified address as an official hit when verification fails", async () => {
		const genericResult = {
			title: "Generic package result",
			url: "https://example.test/package",
			snippet: "Fallback result",
		};
		const result = await searchWeb(
			{ query: "npm package definitely-not-a-real-package-pi-go-20260810" },
			{
				verifyOfficialHit: async () => {
					throw new Error("HTTP 404");
				},
				searchBrave: async () => [genericResult],
				searchDuckDuckGo: async () => [genericResult],
			},
		);

		expect(result.details.provider).not.toBe("official");
		expect(result.details.officialSourceFirstHit).toBe(false);
		expect(result.details.officialSourceVerified).toBe(false);
		expect(result.details.fallbackReason).toContain("HTTP 404");
	});

	test("stops after one generic downgrade when an official source and Brave both fail", async () => {
		vi.stubEnv("BRAVE_API_KEY", "fixture-key");
		const searchDuckDuckGo = vi.fn(async () => []);

		await expect(
			searchWeb(
				{ query: "npm package missing-package" },
				{
					verifyOfficialHit: async () => {
						throw new Error("official unavailable");
					},
					searchBrave: async () => {
						throw new Error("brave unavailable");
					},
					searchDuckDuckGo,
				},
			),
		).rejects.toThrow(/single generic fallback failed/i);
		expect(searchDuckDuckGo).not.toHaveBeenCalled();
	});
});
