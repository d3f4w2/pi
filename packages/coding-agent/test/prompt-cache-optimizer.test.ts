import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	optimizeOpenAIResponsesPromptCache,
	type PromptCacheOptimization,
} from "../src/core/prompt-cache-optimizer.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

function createModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "openai-responses",
		provider: "custom-openai",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
		...overrides,
	};
}

function createPayload(
	options: {
		cacheKey?: string;
		userText?: string;
		systemText?: string;
		toolDescription?: string;
		textFormatName?: string;
	} = {},
): Record<string, unknown> {
	return {
		model: "gpt-5.6-terra",
		input: [
			{
				role: "developer",
				content: options.systemText ?? "stable-system-instructions",
			},
			{
				role: "user",
				content: [{ type: "input_text", text: options.userText ?? "dynamic-user-a" }],
			},
		],
		tools: [
			{
				type: "function",
				name: "read",
				description: options.toolDescription ?? "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		],
		text: {
			format: {
				type: "json_schema",
				name: options.textFormatName ?? "answer",
				schema: { type: "object", properties: { result: { type: "string" } } },
			},
		},
		stream: true,
		store: false,
		...(options.cacheKey === undefined ? {} : { prompt_cache_key: options.cacheKey }),
	};
}

function payloadCacheKey(payload: unknown): string {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Optimized payload is not an object");
	}
	const key = (payload as Record<string, unknown>).prompt_cache_key;
	if (typeof key !== "string") throw new Error("Optimized payload has no cache key");
	return key;
}

function optimizedKey(result: PromptCacheOptimization): string {
	if (result.diagnostic.reason !== "optimized") {
		throw new Error(`Expected optimized result, received ${result.diagnostic.reason}`);
	}
	return payloadCacheKey(result.payload);
}

describe("shared-prefix prompt cache optimizer", () => {
	it("shares one private key across sessions with the same stable request shape", () => {
		const model = createModel();
		const first = optimizeOpenAIResponsesPromptCache(createPayload({ cacheKey: "session-a" }), model, "/repo");
		const second = optimizeOpenAIResponsesPromptCache(
			createPayload({ cacheKey: "session-b", userText: "different-dynamic-user-tail" }),
			model,
			"/repo",
		);

		const firstKey = optimizedKey(first);
		expect(optimizedKey(second)).toBe(firstKey);
		expect(firstKey).toMatch(/^pi-prefix-v1-[a-f0-9]{48}$/);
		expect(firstKey.length).toBeLessThanOrEqual(64);
		expect(firstKey).not.toContain("repo");
		expect(firstKey).not.toContain("stable-system-instructions");
		expect(first.diagnostic.stableShapeSha256).toHaveLength(64);
		expect(first.diagnostic.stableShapeBytes).toBeGreaterThan(0);
	});

	it("rotates the key when a cache-relevant stable input changes", () => {
		const model = createModel();
		const baseline = optimizedKey(
			optimizeOpenAIResponsesPromptCache(createPayload({ cacheKey: "session" }), model, "/repo"),
		);
		const variants = [
			optimizeOpenAIResponsesPromptCache(createPayload({ cacheKey: "session" }), model, "/other-repo"),
			optimizeOpenAIResponsesPromptCache(
				createPayload({ cacheKey: "session" }),
				createModel({ id: "gpt-5.6-sol" }),
				"/repo",
			),
			optimizeOpenAIResponsesPromptCache(
				createPayload({ cacheKey: "session", systemText: "changed-system" }),
				model,
				"/repo",
			),
			optimizeOpenAIResponsesPromptCache(
				createPayload({ cacheKey: "session", toolDescription: "Changed tool" }),
				model,
				"/repo",
			),
			optimizeOpenAIResponsesPromptCache(
				createPayload({ cacheKey: "session", textFormatName: "different-answer" }),
				model,
				"/repo",
			),
		];

		for (const variant of variants) expect(optimizedKey(variant)).not.toBe(baseline);
	});

	it("fails open for unsupported, disabled, or malformed payloads", () => {
		const payload = createPayload({ cacheKey: "session" });
		const unsupported = optimizeOpenAIResponsesPromptCache(
			payload,
			createModel({ api: "anthropic-messages" }),
			"/repo",
		);
		const disabledPayload = createPayload();
		const disabled = optimizeOpenAIResponsesPromptCache(disabledPayload, createModel(), "/repo");
		const malformedPayload = { prompt_cache_key: "session", input: "not-an-array" };
		const malformed = optimizeOpenAIResponsesPromptCache(malformedPayload, createModel(), "/repo");

		expect(unsupported.payload).toBe(payload);
		expect(unsupported.diagnostic.reason).toBe("unsupported-api");
		expect(disabled.payload).toBe(disabledPayload);
		expect(disabled.diagnostic.reason).toBe("cache-disabled");
		expect(malformed.payload).toBe(malformedPayload);
		expect(malformed.diagnostic.reason).toBe("invalid-payload");
	});
});

describe("SDK prompt cache payload integration", () => {
	const sessions: Array<{ dispose(): void }> = [];

	afterEach(() => {
		while (sessions.length > 0) sessions.pop()?.dispose();
	});

	it("applies the shared-prefix key to the final provider payload", async () => {
		const model = createModel();
		const sessionManager = SessionManager.inMemory("/repo");
		sessionManager.newSession({ id: "session-a" });
		const { session } = await createAgentSession({
			cwd: "/repo",
			model,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		const transformed = await session.agent.onPayload?.(createPayload({ cacheKey: "session-a" }), model);
		if (transformed === undefined) throw new Error("SDK payload hook returned undefined");

		expect(payloadCacheKey(transformed)).toMatch(/^pi-prefix-v1-/);
		expect(session.agent.sessionId).toBe("session-a");
	});

	it("preserves a cache key explicitly replaced by an extension", async () => {
		const model = createModel();
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("before_provider_request", (event) => ({
					...event,
					prompt_cache_key: "extension-owned-key",
				}));
			},
		]);
		const { session } = await createAgentSession({
			cwd: "/repo",
			model,
			sessionManager: SessionManager.inMemory("/repo"),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		sessions.push(session);

		const transformed = await session.agent.onPayload?.(createPayload({ cacheKey: "session-a" }), model);
		if (typeof transformed !== "object" || transformed === null || Array.isArray(transformed)) {
			throw new Error("SDK payload hook returned an invalid payload");
		}

		expect((transformed as Record<string, unknown>).prompt_cache_key).toBe("extension-owned-key");
	});
});
