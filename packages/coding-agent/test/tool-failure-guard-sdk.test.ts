import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("coding-agent repeated tool failure guard", () => {
	const sessions: Array<{ dispose(): void }> = [];

	afterEach(() => {
		while (sessions.length > 0) sessions.pop()?.dispose();
	});

	it("enables a two-failure limit by default", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model unavailable");
		const { session } = await createAgentSession({
			model,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(process.cwd()),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		expect(session.agent.repeatedToolFailureLimit).toBe(2);
	});

	it("honors disabled and custom settings", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model unavailable");
		const disabled = await createAgentSession({
			model,
			settingsManager: SettingsManager.inMemory({
				toolFailureGuard: { enabled: false, repeatLimit: 5 },
			}),
			sessionManager: SessionManager.inMemory(process.cwd()),
			resourceLoader: createTestResourceLoader(),
		});
		const custom = await createAgentSession({
			model,
			settingsManager: SettingsManager.inMemory({
				toolFailureGuard: { enabled: true, repeatLimit: 4 },
			}),
			sessionManager: SessionManager.inMemory(process.cwd()),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(disabled.session, custom.session);

		expect(disabled.session.agent.repeatedToolFailureLimit).toBe(0);
		expect(custom.session.agent.repeatedToolFailureLimit).toBe(4);
	});
});
