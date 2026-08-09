import { describe, expect, it } from "vitest";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

describe("tool execution protection settings", () => {
	it("uses conservative defaults", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getToolFailureGuardSettings()).toEqual({
			enabled: true,
			repeatLimit: 2,
			consecutiveLimit: 3,
			cooldownMs: 30_000,
			timeoutMs: 180_000,
		});
	});

	it("clamps configured values and permits disabling the generic timeout", () => {
		const manager = SettingsManager.inMemory({
			toolFailureGuard: {
				enabled: true,
				repeatLimit: 100,
				consecutiveLimit: -10,
				cooldownMs: 100_000_000,
				timeoutMs: 0,
			},
		});

		expect(manager.getToolFailureGuardSettings()).toEqual({
			enabled: true,
			repeatLimit: 10,
			consecutiveLimit: 1,
			cooldownMs: 86_400_000,
			timeoutMs: 0,
		});
	});

	it("falls back safely for malformed values", () => {
		const malformed = {
			toolFailureGuard: {
				enabled: "yes",
				repeatLimit: "many",
				consecutiveLimit: Number.NaN,
				cooldownMs: "later",
				timeoutMs: Number.POSITIVE_INFINITY,
			},
		} as unknown as Partial<Settings>;
		const manager = SettingsManager.inMemory(malformed);

		expect(manager.getToolFailureGuardSettings()).toEqual({
			enabled: true,
			repeatLimit: 2,
			consecutiveLimit: 3,
			cooldownMs: 30_000,
			timeoutMs: 180_000,
		});
	});
});
