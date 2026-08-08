import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import { showApiDashboard } from "../src/extensions/api/ui.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const keybindings = {
	matches: () => false,
} as unknown as KeybindingsManager;

const tui = {
	requestRender: () => {},
} as unknown as TUI;

describe("API provider dashboard", () => {
	test("does not render lines wider than the terminal", () => {
		const width = 120;
		const dashboard = showApiDashboard(tui, theme, keybindings, [], () => {});

		for (const [index, line] of dashboard.render(width).entries()) {
			expect(visibleWidth(line), `line ${index} exceeds ${width} columns`).toBeLessThanOrEqual(width);
		}
	});
});
