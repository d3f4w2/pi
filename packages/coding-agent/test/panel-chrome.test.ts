import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PanelHeaderComponent, PanelHintComponent } from "../src/modes/interactive/components/panel-chrome.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { setLanguageSetting } from "../src/modes/interactive/i18n/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("workbench panel chrome", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => setLanguageSetting("en"));

	it("renders a restrained title rail and compact key hints", () => {
		const header = new PanelHeaderComponent("模型");
		const hint = new PanelHintComponent(["↑/↓ 选择", "Enter 确认", "Esc 返回"]);

		for (const width of [24, 40, 80]) {
			const lines = [...header.render(width), ...hint.render(width)];
			expect(stripAnsi(lines[0] ?? "")).toContain("› 模型");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("gives thinking selection the same title and interaction hint", () => {
		setLanguageSetting("zh-CN");
		const selector = new ThinkingSelectorComponent(
			"high",
			["off", "high"],
			() => {},
			() => {},
			"思考等级",
		);
		const output = stripAnsi(selector.render(60).join("\n"));

		expect(output).toContain("› 思考等级");
		expect(output).toContain("↑/↓ 选择");
		expect(output).toContain("Enter 确认");
		expect(output).toContain("Esc 返回");
	});
});
