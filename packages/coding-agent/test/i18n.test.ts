import { afterEach, describe, expect, it } from "vitest";
import {
	detectUiLanguage,
	getLanguageSetting,
	getUiLanguage,
	setLanguageSetting,
	t,
} from "../src/modes/interactive/i18n/index.ts";

describe("interactive i18n", () => {
	afterEach(() => setLanguageSetting("auto", "en-US"));

	it("resolves explicit and automatic language settings", () => {
		expect(detectUiLanguage("zh-CN", "en-US")).toBe("zh-CN");
		expect(detectUiLanguage("en", "zh-CN")).toBe("en");
		expect(detectUiLanguage("auto", "zh-TW")).toBe("zh-CN");
		expect(detectUiLanguage("auto", "en-GB")).toBe("en");
	});

	it("updates the active language without a restart", () => {
		setLanguageSetting("zh-CN");
		expect(getLanguageSetting()).toBe("zh-CN");
		expect(getUiLanguage()).toBe("zh-CN");
		expect(t("settings.title")).toBe("设置");

		setLanguageSetting("en");
		expect(t("settings.title")).toBe("Settings");
	});

	it("interpolates values after translation", () => {
		setLanguageSetting("zh-CN");
		expect(t("settings.followUp.description", { key: "Ctrl+Enter" })).toContain("Ctrl+Enter");
	});
});
