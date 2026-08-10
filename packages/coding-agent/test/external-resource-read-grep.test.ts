import { describe, expect, test, vi } from "vitest";

vi.mock("../src/extensions/web/source-adapters.ts", () => ({
	resolveExternalResource: vi.fn(async (address: string) => ({
		data: new TextEncoder().encode("alpha line\nneedle first\nbeta line\nneedle second\n"),
		sourceAddress: address,
		finalUrl: "https://registry.npmjs.org/fixture",
		contentType: "text/plain; charset=utf-8",
		cached: true,
		readAt: "2026-08-10T00:00:00.000Z",
		truncated: false,
		untrusted: true,
		contentSha256: "a".repeat(64),
	})),
	resolveStructuredWebUrl: vi.fn(async () => undefined),
}));

import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

describe("external resource read and grep integration", () => {
	test("reads a canonical address with the complete metadata envelope", async () => {
		const tool = createReadToolDefinition(process.cwd());
		const result = await tool.execute("read-resource", { path: "npm://fixture" }, undefined, undefined, {} as never);
		const text = result.content.find((item) => item.type === "text")?.text ?? "";

		expect(text).toContain("source=npm://fixture");
		expect(text).toContain("cache=hit");
		expect(text).toContain("untrusted=true");
		expect(text).toContain("needle first");
		expect(result.details?.source).toMatchObject({
			sourceAddress: "npm://fixture",
			cached: true,
			truncated: false,
			untrusted: true,
		});
	});

	test("marks external metadata truncated when offset or limit omits content", async () => {
		const tool = createReadToolDefinition(process.cwd());
		const result = await tool.execute(
			"read-resource-range",
			{ path: "npm://fixture", limit: 5 },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content.find((item) => item.type === "text")?.text ?? "";

		expect(text).toContain("truncated=true");
		expect(text).toContain("needle first");
		expect(text).not.toContain("needle second");
		expect(result.details?.source?.truncated).toBe(true);
	});

	test("performs bounded in-memory grep without invoking a filesystem backend", async () => {
		const tool = createGrepToolDefinition(process.cwd(), {
			operations: {
				isDirectory: vi.fn(async () => {
					throw new Error("filesystem must not run");
				}),
				readFile: vi.fn(async () => {
					throw new Error("filesystem must not run");
				}),
			},
		});
		const result = await tool.execute(
			"grep-resource",
			{ path: "npm://fixture", pattern: "needle", literal: true, context: 1, limit: 1 },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content.find((item) => item.type === "text")?.text ?? "";

		expect(text).toContain("npm://fixture:2: needle first");
		expect(text).toContain("1 matches limit reached");
		expect(text).toContain("source=npm://fixture");
		expect(result.details).toMatchObject({ matchLimitReached: 1 });
	});
});
