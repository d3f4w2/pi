import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	CACHE_DEVELOPER_CONTEXT_REVOCATION,
	CACHE_DEVELOPER_CONTEXT_TYPE,
	convertToLlm,
	planDynamicDeveloperContext,
} from "../src/core/messages.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("append-only dynamic developer context", () => {
	const sessions: AgentSession[] = [];

	afterEach(() => {
		while (sessions.length > 0) sessions.pop()?.dispose();
	});

	it("moves an exact appended suffix into a persisted hidden revision", () => {
		const plan = planDynamicDeveloperContext("stable", "stable\n\ndynamic-v1", undefined, true);

		expect(plan.systemPrompt).toBe("stable");
		expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.message).toMatchObject({
			role: "custom",
			customType: CACHE_DEVELOPER_CONTEXT_TYPE,
			content: "\n\ndynamic-v1",
			display: false,
		});
	});

	it("does not append an unchanged revision", () => {
		const first = planDynamicDeveloperContext("stable", "stable\n\ndynamic-v1", undefined, true);
		const second = planDynamicDeveloperContext("stable", "stable\n\ndynamic-v1", first.digest, true);

		expect(second.systemPrompt).toBe("stable");
		expect(second.message).toBeUndefined();
	});

	it("revokes an earlier revision inside a changed appended suffix", () => {
		const first = planDynamicDeveloperContext("stable", "stable\n\ndynamic-v1", undefined, true);
		const changed = planDynamicDeveloperContext("stable", "stable\n\ndynamic-v2", first.state, true);

		expect(changed.systemPrompt).toBe("stable");
		expect(changed.message?.content).toBe(`${CACHE_DEVELOPER_CONTEXT_REVOCATION}\n\n\n\ndynamic-v2`);
	});

	it("revokes a removed suffix so an older revision cannot remain active", () => {
		const first = planDynamicDeveloperContext("stable", "stable\n\ndynamic-v1", undefined, true);
		const removed = planDynamicDeveloperContext("stable", "stable", first.digest, true);

		expect(removed.message?.content).toBe(CACHE_DEVELOPER_CONTEXT_REVOCATION);
		expect(removed.digest).toBeUndefined();
	});

	it("keeps the original full system prompt when the provider or prefix is ineligible", () => {
		const replaced = planDynamicDeveloperContext("stable", "replacement", undefined, true);
		const unsupported = planDynamicDeveloperContext("stable", "stable\n\ndynamic", undefined, false);

		expect(replaced).toEqual({ systemPrompt: "replacement" });
		expect(unsupported).toEqual({ systemPrompt: "stable\n\ndynamic" });
	});

	it("revokes an earlier revision before falling back to a replaced system prompt", () => {
		const first = planDynamicDeveloperContext("stable", "stable\n\ndynamic-v1", undefined, true);
		const replaced = planDynamicDeveloperContext("stable", "replacement", first.state, true);

		expect(replaced.systemPrompt).toBe("replacement");
		expect(replaced.state).toBeNull();
		expect(replaced.message?.content).toBe(CACHE_DEVELOPER_CONTEXT_REVOCATION);
	});

	it("uses a private sentinel only on the OpenAI payload path", () => {
		const plan = planDynamicDeveloperContext("stable", "stable\n\ndynamic-v1", undefined, true);
		if (!plan.message) throw new Error("Expected a developer-context message");

		const sentinel = convertToLlm([plan.message], { cacheDeveloperContext: "sentinel" });
		const plain = convertToLlm([plan.message], { cacheDeveloperContext: "plain" });
		const omitted = convertToLlm([plan.message], { cacheDeveloperContext: "omit" });

		expect(sentinel[0]).toMatchObject({ role: "user" });
		expect(JSON.stringify(sentinel)).toContain("pi-cache-developer-context-v1");
		expect(JSON.stringify(plain)).not.toContain("pi-cache-developer-context-v1");
		expect(JSON.stringify(plain)).toContain("dynamic-v1");
		expect(omitted).toEqual([]);
	});

	it("persists only changed revisions across real AgentSession turns", async () => {
		let suffix = "\n\nrevision-v1";
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + suffix }));
			},
		]);
		const model: Model<"openai-responses"> = {
			id: "test-responses",
			name: "Test Responses",
			api: "openai-responses",
			provider: "test-openai",
			baseUrl: "https://example.invalid/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		const agent = new Agent({
			initialState: { model, systemPrompt: "", tools: [] },
			streamFn: (requestModel) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("ok"),
							api: requestModel.api,
							provider: requestModel.provider,
							model: requestModel.id,
						},
					});
				});
				return stream;
			},
		});
		const modelRuntime = {
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test" }),
			getAvailableSnapshot: () => [model],
			getModel: () => model,
		} as unknown as ModelRuntime;
		const sessionManager = SessionManager.inMemory("/repo");
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: "/repo",
			modelRuntime,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		sessions.push(session);

		await session.prompt("one");
		await session.prompt("two");
		suffix = "\n\nrevision-v2";
		await session.prompt("three");

		const revisions = session.messages.filter(
			(message) => message.role === "custom" && message.customType === CACHE_DEVELOPER_CONTEXT_TYPE,
		);
		const persisted = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === CACHE_DEVELOPER_CONTEXT_TYPE);
		expect(
			revisions.map((message) => {
				if (message.role !== "custom") throw new Error("Expected custom revision");
				return message.content;
			}),
		).toEqual(["\n\nrevision-v1", `${CACHE_DEVELOPER_CONTEXT_REVOCATION}\n\n\n\nrevision-v2`]);
		expect(persisted).toHaveLength(2);
		expect(session.systemPrompt).toBe(session.promptCacheStableSystemPrompt);
	});
});
