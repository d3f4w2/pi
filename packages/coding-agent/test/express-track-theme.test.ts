import { describe, expect, test } from "vitest";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("Express Track palette", () => {
	test("uses ice blue and warm white in the dark theme", () => {
		initTheme("dark", false);
		expect(theme.getFgAnsi("accent")).toContain("38;2;125;211;252");
		expect(theme.getFgAnsi("text")).toContain("38;2;242;239;230");
		expect(theme.getFgAnsi("warning")).not.toBe(theme.getFgAnsi("accent"));
		expect(theme.getFgAnsi("success")).not.toBe(theme.getFgAnsi("accent"));
	});

	test("keeps the same identity with accessible darker values in the light theme", () => {
		initTheme("light", false);
		expect(theme.getFgAnsi("accent")).toContain("38;2;22;119;166");
		expect(theme.getFgAnsi("text")).toContain("38;2;40;37;31");
		expect(theme.getFgAnsi("error")).not.toBe(theme.getFgAnsi("accent"));
	});
});
