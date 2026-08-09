export const LANGUAGE_SETTINGS = ["auto", "zh-CN", "en"] as const;

export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];

export function isLanguageSetting(value: unknown): value is LanguageSetting {
	return typeof value === "string" && LANGUAGE_SETTINGS.includes(value as LanguageSetting);
}
