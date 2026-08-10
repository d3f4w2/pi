import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_DEVELOPER_CONTEXT_SENTINEL } from "../src/core/messages.ts";
import {
	optimizeOpenAIResponsesPromptCache,
	PromptCacheDiagnosticTracker,
	type PromptCacheOptimization,
	type PromptCacheRequestDiagnostic,
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
		toolNames?: string[];
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
		tools: (options.toolNames ?? ["read"]).map((name) => ({
			type: "function",
			name,
			description: options.toolDescription ?? "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		})),
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
		expect(firstKey).toMatch(/^pi-prefix-v2-[a-f0-9]{48}$/);
		expect(firstKey.length).toBeLessThanOrEqual(64);
		expect(firstKey).not.toContain("repo");
		expect(firstKey).not.toContain("stable-system-instructions");
		expect(first.diagnostic.stableShapeSha256).toHaveLength(64);
		expect(first.diagnostic.stableShapeBytes).toBeGreaterThan(0);
	});

	it("keeps a stable route and moves the explicit breakpoint before dynamic system suffixes", () => {
		const stableSystemPrompt = "stable-system-instructions";
		const firstFullPrompt = `${stableSystemPrompt}\n\n<dynamic>task revision 1</dynamic>`;
		const secondFullPrompt = `${stableSystemPrompt}\n\n<dynamic>task revision 2</dynamic>`;
		const model = createModel({
			compat: {
				supportsExplicitPromptCacheMode: true,
				supportsPromptCacheBreakpoints: true,
			},
		});
		const first = optimizeOpenAIResponsesPromptCache(
			createPayload({ cacheKey: "session-a", systemText: firstFullPrompt }),
			model,
			"/repo",
			{ stableSystemPrompt },
		);
		const second = optimizeOpenAIResponsesPromptCache(
			createPayload({ cacheKey: "session-b", systemText: secondFullPrompt }),
			model,
			"/repo",
			{ stableSystemPrompt },
		);

		expect(optimizedKey(second)).toBe(optimizedKey(first));
		expect(second.diagnostic.stableSystemPromptSha256).toBe(first.diagnostic.stableSystemPromptSha256);
		expect(second.diagnostic.fullSystemPromptSha256).not.toBe(first.diagnostic.fullSystemPromptSha256);
		expect(second.diagnostic.dynamicSystemPromptBytes).toBeGreaterThan(0);
		expect(second.diagnostic.explicitBreakpoint).toBe("applied");

		const payload = second.payload as Record<string, unknown>;
		const input = payload.input as Array<Record<string, unknown>>;
		const content = input[0].content as Array<Record<string, unknown>>;
		expect(content).toEqual([
			{
				type: "input_text",
				text: stableSystemPrompt,
				prompt_cache_breakpoint: { mode: "explicit" },
			},
			{ type: "input_text", text: "\n\n<dynamic>task revision 2</dynamic>" },
		]);
		expect(content.map((item) => item.text).join("")).toBe(secondFullPrompt);
		expect(payload.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("keeps unsupported and mismatched explicit breakpoints off without losing stable routing", () => {
		const stableSystemPrompt = "stable-system-instructions";
		const fullPrompt = `${stableSystemPrompt}\n\ndynamic`;
		const unsupported = optimizeOpenAIResponsesPromptCache(
			createPayload({ cacheKey: "session", systemText: fullPrompt }),
			createModel(),
			"/repo",
			{ stableSystemPrompt },
		);
		expect(unsupported.diagnostic.explicitBreakpoint).toBe("unsupported");
		expect(
			((unsupported.payload as Record<string, unknown>).input as Array<Record<string, unknown>>)[0].content,
		).toBe(fullPrompt);

		const capableModel = createModel({
			compat: {
				supportsExplicitPromptCacheMode: true,
				supportsPromptCacheBreakpoints: true,
			},
		});
		const mismatch = optimizeOpenAIResponsesPromptCache(
			createPayload({ cacheKey: "session", systemText: "different-system" }),
			capableModel,
			"/repo",
			{ stableSystemPrompt },
		);
		expect(mismatch.diagnostic.explicitBreakpoint).toBe("prefix-mismatch");
		expect(((mismatch.payload as Record<string, unknown>).input as Array<Record<string, unknown>>)[0].content).toBe(
			"different-system",
		);
	});

	it("restores hidden append-only context as a developer message without exposing the sentinel", () => {
		const model = createModel();
		const payload = createPayload({ cacheKey: "session" });
		const input = payload.input as Array<Record<string, unknown>>;
		input.push({
			role: "user",
			content: [{ type: "input_text", text: `${CACHE_DEVELOPER_CONTEXT_SENTINEL}\n\ndynamic-v2` }],
		});

		const result = optimizeOpenAIResponsesPromptCache(payload, model, "/repo", {
			stableSystemPrompt: "stable-system-instructions",
		});
		const transformed = result.payload as Record<string, unknown>;
		const transformedInput = transformed.input as Array<Record<string, unknown>>;

		expect(transformedInput.at(-1)).toEqual({
			role: "developer",
			content: [{ type: "input_text", text: "\n\ndynamic-v2" }],
		});
		expect(JSON.stringify(transformed)).not.toContain("pi-cache-developer-context-v1");
	});

	it("restores hidden developer context even when prompt caching is disabled", () => {
		const payload = createPayload();
		(payload.input as Array<Record<string, unknown>>).push({
			role: "user",
			content: [{ type: "input_text", text: `${CACHE_DEVELOPER_CONTEXT_SENTINEL}\n\ndynamic` }],
		});

		const result = optimizeOpenAIResponsesPromptCache(payload, createModel(), "/repo");
		const input = (result.payload as Record<string, unknown>).input as Array<Record<string, unknown>>;

		expect(result.diagnostic.reason).toBe("cache-disabled");
		expect(input.at(-1)).toEqual({
			role: "developer",
			content: [{ type: "input_text", text: "\n\ndynamic" }],
		});
		expect(JSON.stringify(result.payload)).not.toContain("pi-cache-developer-context-v1");
	});

	it("applies at most four positive-ROI breakpoints across a long append-only prompt", () => {
		const model = createModel({
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
			compat: {
				supportsExplicitPromptCacheMode: true,
				supportsPromptCacheBreakpoints: true,
			},
		});
		const payload = createPayload({ cacheKey: "session" });
		const input = payload.input as Array<Record<string, unknown>>;
		for (let index = 0; index < 6; index++) {
			input.push({
				role: "user",
				content: [{ type: "input_text", text: `${index}-${"x".repeat(8_192)}` }],
			});
		}

		const result = optimizeOpenAIResponsesPromptCache(payload, model, "/repo", {
			stableSystemPrompt: "stable-system-instructions",
		});
		const transformed = result.payload as Record<string, unknown>;
		const serialized = JSON.stringify(transformed.input);
		const breakpointCount = serialized.match(/prompt_cache_breakpoint/g)?.length ?? 0;

		expect(breakpointCount).toBe(4);
		expect(result.diagnostic.breakpointsApplied).toBe(4);
		expect(result.diagnostic.breakpointCandidates).toBe(6);
		expect(result.diagnostic.breakpointDecision).toBe("positive-roi");
	});

	it("suppresses history breakpoints when their write premium exceeds one expected read", () => {
		const model = createModel({
			cost: { input: 1, output: 2, cacheRead: 0.9, cacheWrite: 5 },
			compat: {
				supportsExplicitPromptCacheMode: true,
				supportsPromptCacheBreakpoints: true,
			},
		});
		const payload = createPayload({ cacheKey: "session" });
		(payload.input as Array<Record<string, unknown>>).push({
			role: "user",
			content: [{ type: "input_text", text: "x".repeat(16_384) }],
		});

		const result = optimizeOpenAIResponsesPromptCache(payload, model, "/repo", {
			stableSystemPrompt: "stable-system-instructions",
		});
		const breakpointCount = JSON.stringify((result.payload as Record<string, unknown>).input).match(
			/prompt_cache_breakpoint/g,
		)?.length;

		expect(breakpointCount).toBe(1);
		expect(result.diagnostic.breakpointsApplied).toBe(1);
		expect(result.diagnostic.breakpointDecision).toBe("write-cost-exceeds-reuse");
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

	it("classifies suffix-only changes, tool-order drift, and hot keys without exposing content", () => {
		const model = createModel();
		const tracker = new PromptCacheDiagnosticTracker();
		const stableSystemPrompt = "private-stable-system";
		const first = optimizeOpenAIResponsesPromptCache(
			createPayload({
				cacheKey: "a",
				systemText: `${stableSystemPrompt}\n\nprivate-suffix-a`,
				toolNames: ["read", "write"],
			}),
			model,
			"C:/private/project",
			{ stableSystemPrompt },
		);
		const suffixChanged = optimizeOpenAIResponsesPromptCache(
			createPayload({
				cacheKey: "b",
				systemText: `${stableSystemPrompt}\n\nprivate-suffix-b`,
				toolNames: ["read", "write"],
			}),
			model,
			"C:/private/project",
			{ stableSystemPrompt },
		);
		const orderChanged = optimizeOpenAIResponsesPromptCache(
			createPayload({
				cacheKey: "c",
				systemText: `${stableSystemPrompt}\n\nprivate-suffix-b`,
				toolNames: ["write", "read"],
			}),
			model,
			"C:/private/project",
			{ stableSystemPrompt },
		);

		tracker.record(first.diagnostic, 1_000);
		const suffixDiagnostic = tracker.record(suffixChanged.diagnostic, 2_000);
		const orderDiagnostic = tracker.record(orderChanged.diagnostic, 3_000);
		expect(suffixDiagnostic.keyChanged).toBe(false);
		expect(suffixDiagnostic.changes).toEqual(["dynamic-system-suffix"]);
		expect(orderDiagnostic.keyChanged).toBe(true);
		expect(orderDiagnostic.changes).toContain("tool-order");

		const hotKeyTracker = new PromptCacheDiagnosticTracker();
		let hot: PromptCacheRequestDiagnostic | undefined;
		for (let index = 0; index < 16; index++) hot = hotKeyTracker.record(first.diagnostic, 10_000 + index);
		expect(hot?.requestsPerMinute).toBe(16);
		expect(hot?.hotKey).toBe(true);
		const serialized = JSON.stringify(hot);
		expect(serialized).not.toContain("private-stable-system");
		expect(serialized).not.toContain("private-suffix");
		expect(serialized).not.toContain("C:/private/project");
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

		expect(payloadCacheKey(transformed)).toMatch(/^pi-prefix-v2-/);
		expect(session.agent.sessionId).toBe("session-a");
	});

	it("uses the AgentSession base prompt as the stable boundary and emits redacted diagnostics", async () => {
		const diagnostics: PromptCacheRequestDiagnostic[] = [];
		const model = createModel({
			compat: {
				supportsExplicitPromptCacheMode: true,
				supportsPromptCacheBreakpoints: true,
			},
		});
		const { session } = await createAgentSession({
			cwd: "/repo",
			model,
			sessionManager: SessionManager.inMemory("/repo"),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			onPromptCacheDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		sessions.push(session);

		const stableSystemPrompt = session.systemPrompt;
		const fullSystemPrompt = `${stableSystemPrompt}\n\n<dynamic>revision 2</dynamic>`;
		session.agent.state.systemPrompt = fullSystemPrompt;
		const transformed = await session.agent.onPayload?.(
			createPayload({ cacheKey: "session-a", systemText: fullSystemPrompt }),
			model,
		);
		if (transformed === undefined) throw new Error("SDK payload hook returned undefined");

		expect(session.promptCacheStableSystemPrompt).toBe(stableSystemPrompt);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].explicitBreakpoint).toBe("applied");
		expect(JSON.stringify(diagnostics[0])).not.toContain("revision 2");
	});

	it("ignores a throwing diagnostics observer", async () => {
		const model = createModel();
		const { session } = await createAgentSession({
			cwd: "/repo",
			model,
			sessionManager: SessionManager.inMemory("/repo"),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			onPromptCacheDiagnostic: () => {
				throw new Error("observer failed");
			},
		});
		sessions.push(session);

		await expect(session.agent.onPayload?.(createPayload({ cacheKey: "session-a" }), model)).resolves.toBeDefined();
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
