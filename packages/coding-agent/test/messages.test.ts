import { describe, expect, it } from "vitest";
import {
	type CustomMessage,
	convertToLlm,
	getMessageConversionMemoStats,
	resetMessageConversionMemoForTests,
} from "../src/core/messages.ts";

describe("message conversion memo", () => {
	it("reuses a completed custom-message conversion by identity", () => {
		resetMessageConversionMemoForTests();
		const message: CustomMessage = {
			role: "custom",
			customType: "large-context",
			content: "x".repeat(32_000),
			display: false,
			timestamp: 1,
		};

		const first = convertToLlm([message]);
		const second = convertToLlm([message]);

		expect(second[0]).toBe(first[0]);
		expect(getMessageConversionMemoStats()).toEqual({ hits: 1, misses: 1 });
	});

	it("invalidates when a mutation-sensitive field changes", () => {
		resetMessageConversionMemoForTests();
		const message: CustomMessage = {
			role: "custom",
			customType: "context",
			content: "v1",
			display: false,
			timestamp: 1,
		};
		const first = convertToLlm([message]);
		message.content = "v2";
		const second = convertToLlm([message]);

		expect(second[0]).not.toBe(first[0]);
		expect(JSON.stringify(second)).toContain("v2");
		expect(getMessageConversionMemoStats()).toEqual({ hits: 0, misses: 2 });
	});

	it("keeps sentinel, plain, and omitted developer-context modes isolated", () => {
		resetMessageConversionMemoForTests();
		const message: CustomMessage = {
			role: "custom",
			customType: "pi.cache.developer-context.v1",
			content: "dynamic",
			display: false,
			timestamp: 1,
		};

		expect(convertToLlm([message], { cacheDeveloperContext: "omit" })).toEqual([]);
		expect(JSON.stringify(convertToLlm([message], { cacheDeveloperContext: "plain" }))).not.toContain("sentinel");
		expect(JSON.stringify(convertToLlm([message], { cacheDeveloperContext: "sentinel" }))).toContain(
			"pi-cache-developer-context-v1",
		);
	});
});
