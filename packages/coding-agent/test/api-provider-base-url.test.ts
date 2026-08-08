import { describe, expect, test } from "vitest";
import { suggestOpenAIBaseUrl } from "../src/extensions/api/types.ts";

describe("suggestOpenAIBaseUrl", () => {
	test.each(["openai-responses", "openai-completions"] as const)("suggests /v1 for a root %s URL", (api) => {
		expect(suggestOpenAIBaseUrl(api, "https://example.test")).toBe("https://example.test/v1");
		expect(suggestOpenAIBaseUrl(api, "https://example.test/")).toBe("https://example.test/v1");
	});

	test("does not change URLs that already contain a path", () => {
		expect(suggestOpenAIBaseUrl("openai-responses", "https://example.test/api")).toBeUndefined();
		expect(suggestOpenAIBaseUrl("openai-completions", "https://example.test/v1")).toBeUndefined();
	});

	test("does not suggest /v1 for Anthropic", () => {
		expect(suggestOpenAIBaseUrl("anthropic-messages", "https://example.test")).toBeUndefined();
	});

	test("ignores invalid URLs and root URLs with query parameters", () => {
		expect(suggestOpenAIBaseUrl("openai-responses", "not-a-url")).toBeUndefined();
		expect(suggestOpenAIBaseUrl("openai-responses", "https://example.test?gateway=custom")).toBeUndefined();
	});
});
