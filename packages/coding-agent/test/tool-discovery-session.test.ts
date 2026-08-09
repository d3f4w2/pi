import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import astGrepExtension from "../src/extensions/ast-grep/index.ts";
import { createToolsExtension } from "../src/extensions/tools/index.ts";
import type { ToolPreferencesStore } from "../src/extensions/tools/storage.ts";
import webExtension from "../src/extensions/web/index.ts";

describe("tool discovery session", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	test("hides low-frequency tools and activates new matches in the same agent run", async () => {
		const preferences: ToolPreferencesStore = {
			load: async () => ({ enabledTools: [], disabledTools: [] }),
			recordChanges: async () => {},
		};
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [createToolsExtension(preferences), astGrepExtension, webExtension],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});

		expect(session.getActiveToolNames()).toContain("tool_search");
		expect(session.getActiveToolNames()).not.toContain("ast_grep");
		expect(session.getActiveToolNames()).not.toContain("web_search");

		const toolSearch = session.agent.state.tools.find((tool) => tool.name === "tool_search");
		await toolSearch?.execute("find-web-tools", { query: "网页资料" });

		expect(session.getActiveToolNames()).toContain("web_search");
		expect(session.getActiveToolNames()).toContain("web_fetch");
		expect(session.getActiveToolNames()).not.toContain("ast_grep");

		const nextToolSearch = session.agent.state.tools.find((tool) => tool.name === "tool_search");
		await nextToolSearch?.execute("find-structure-tool", { query: "代码结构" });

		expect(session.getActiveToolNames()).toContain("ast_grep");
		expect(session.getActiveToolNames()).not.toContain("web_search");
		expect(session.getActiveToolNames()).not.toContain("web_fetch");

		session.dispose();
	});
});
