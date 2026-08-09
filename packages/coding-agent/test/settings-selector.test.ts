import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { setLanguageSetting } from "../src/modes/interactive/i18n/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		setLanguageSetting("en");
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const config = {
			language: "auto",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});

	it("changes language through the Language setting", () => {
		const onLanguageChange = vi.fn();
		const config = {
			language: "auto",
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = { onLanguageChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		expect(list.render(120).join("\n")).toContain("Language");
		for (const character of "Language") list.handleInput(character);
		list.handleInput("\r");
		expect(list.render(80).join("\n")).toContain("Choose the language used by Pi-go");
		list.handleInput("\x1b[B");
		list.handleInput("\r");

		expect(onLanguageChange).toHaveBeenCalledWith("zh-CN");
	});

	it("renders the settings shell in Chinese", () => {
		setLanguageSetting("zh-CN");
		try {
			const config = {
				language: "zh-CN",
				warnings: {},
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig;
			const component = new SettingsSelectorComponent(config, {} as SettingsCallbacks);
			const rendered = component.render(120).join("\n");

			expect(rendered).toContain("界面语言");
			expect(rendered).toContain("自动缩小图片");
			expect(rendered).toContain("输入文字搜索");
		} finally {
			setLanguageSetting("en");
		}
	});
});
