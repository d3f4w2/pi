import { describe, expect, test } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { applyToolPreferences, ToolPreferencesStorage } from "../src/extensions/tools/storage.ts";

describe("tool preferences storage", () => {
	test("starts with no user overrides", async () => {
		const storage = new ToolPreferencesStorage(new InMemoryAuthStorageBackend());

		await expect(storage.load()).resolves.toEqual({ enabledTools: [], disabledTools: [] });
	});

	test("moves changed tools between enabled and disabled overrides", async () => {
		const backend = new InMemoryAuthStorageBackend();
		const storage = new ToolPreferencesStorage(backend);

		await storage.recordChanges([
			{ toolName: "grep", active: false },
			{ toolName: "find", active: true },
		]);
		await storage.recordChanges([{ toolName: "grep", active: true }]);

		await expect(new ToolPreferencesStorage(backend).load()).resolves.toEqual({
			enabledTools: ["find", "grep"],
			disabledTools: [],
		});
	});

	test("applies known overrides without losing new default tools", () => {
		expect(
			applyToolPreferences(["read", "bash", "code_search"], ["read", "bash", "grep", "code_search"], {
				enabledTools: ["grep", "removed_tool"],
				disabledTools: ["bash"],
			}),
		).toEqual(["read", "code_search", "grep"]);
	});
});
