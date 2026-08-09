import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	BrandHeaderComponent,
	getBrandLogoLines,
	PI_GO_LOADER_FRAMES,
	shouldShowStartupDetails,
} from "../src/modes/interactive/components/brand.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("pi-go brand", () => {
	test("uses a large logo only when the terminal is wide enough", () => {
		expect(getBrandLogoLines(80)).toHaveLength(6);
		expect(getBrandLogoLines(50)).toHaveLength(2);
		expect(getBrandLogoLines(24)).toEqual(["pi-go ›"]);
	});

	test("keeps every logo line inside the terminal", () => {
		for (const width of [24, 50, 80]) {
			for (const line of getBrandLogoLines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("keeps loader frames fixed width so surrounding text does not move", () => {
		const widths = new Set(PI_GO_LOADER_FRAMES.map((frame) => visibleWidth(frame)));
		expect(widths).toEqual(new Set([3]));
	});

	test("keeps startup details hidden until explicitly requested", () => {
		expect(shouldShowStartupDetails({ expanded: false, verbose: false })).toBe(false);
		expect(shouldShowStartupDetails({ expanded: true, verbose: false })).toBe(true);
		expect(shouldShowStartupDetails({ expanded: false, verbose: true })).toBe(true);
	});

	test("keeps the large startup logo while switching help detail", () => {
		initTheme("dark");
		const header = new BrandHeaderComponent({
			version: "1.2.3",
			collapsedText: () => "compact help",
			expandedText: () => "expanded help",
		});

		expect(stripAnsi(header.render(80).join("\n"))).toContain("compact help");
		header.setExpanded(true);
		const expanded = stripAnsi(header.render(80).join("\n"));
		expect(expanded).toContain("expanded help");
		expect(expanded).toContain("v1.2.3");
	});
});
