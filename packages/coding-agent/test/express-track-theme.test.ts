import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getThemesDir } from "../src/config.ts";
import { loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

describe("Express Track palette", () => {
	test("uses ice blue and warm white in the dark theme", () => {
		const theme = loadThemeFromPath(join(getThemesDir(), "dark.json"), "truecolor");
		expect(theme.getFgAnsi("accent")).toContain("38;2;125;211;252");
		expect(theme.getFgAnsi("text")).toContain("38;2;242;239;230");
		expect(theme.getFgAnsi("warning")).not.toBe(theme.getFgAnsi("accent"));
		expect(theme.getFgAnsi("success")).not.toBe(theme.getFgAnsi("accent"));
	});

	test("keeps the same identity with accessible darker values in the light theme", () => {
		const theme = loadThemeFromPath(join(getThemesDir(), "light.json"), "truecolor");
		expect(theme.getFgAnsi("accent")).toContain("38;2;22;119;166");
		expect(theme.getFgAnsi("text")).toContain("38;2;40;37;31");
		expect(theme.getFgAnsi("error")).not.toBe(theme.getFgAnsi("accent"));
	});
});
