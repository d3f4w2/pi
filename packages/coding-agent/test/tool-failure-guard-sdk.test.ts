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
		expect(session.agent.toolConsecutiveFailureLimit).toBe(3);
		expect(session.agent.toolFailureCooldownMs).toBe(30_000);
		expect(session.agent.toolExecutionTimeoutMs).toBe(180_000);
	});

	it("honors disabled and custom settings", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model unavailable");
		const disabled = await createAgentSession({
			model,
			settingsManager: SettingsManager.inMemory({
				toolFailureGuard: {
					enabled: false,
					repeatLimit: 5,
					consecutiveLimit: 6,
					cooldownMs: 12_000,
					timeoutMs: 45_000,
				},
			}),
			sessionManager: SessionManager.inMemory(process.cwd()),
			resourceLoader: createTestResourceLoader(),
		});
		const custom = await createAgentSession({
			model,
			settingsManager: SettingsManager.inMemory({
				toolFailureGuard: {
					enabled: true,
					repeatLimit: 4,
					consecutiveLimit: 5,
					cooldownMs: 12_000,
					timeoutMs: 45_000,
				},
			}),
			sessionManager: SessionManager.inMemory(process.cwd()),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(disabled.session, custom.session);

		expect(disabled.session.agent.repeatedToolFailureLimit).toBe(0);
		expect(disabled.session.agent.toolConsecutiveFailureLimit).toBe(0);
		expect(disabled.session.agent.toolFailureCooldownMs).toBe(0);
		expect(disabled.session.agent.toolExecutionTimeoutMs).toBe(0);
		expect(custom.session.agent.repeatedToolFailureLimit).toBe(4);
		expect(custom.session.agent.toolConsecutiveFailureLimit).toBe(5);
		expect(custom.session.agent.toolFailureCooldownMs).toBe(12_000);
		expect(custom.session.agent.toolExecutionTimeoutMs).toBe(45_000);
	});
});
