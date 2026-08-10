import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	stream as streamOpenAIResponses,
	streamSimple as streamSimpleOpenAIResponses,
} from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

interface CapturedResponsesPayload {
	input?: unknown[];
	previous_response_id?: string;
	prompt_cache_key?: string;
	session_id?: string;
	store?: boolean;
}

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = getModel("openai", "gpt-5.4"),
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	xSessionId: string | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		xSessionId: null as string | null,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.xSessionId = getHeader(init?.headers, "x-session-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it("forwards required tool choice", async () => {
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				messages: [
					{
						role: "user",
						content: "Do not call ping. Respond with text instead.",
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "ping",
						description: "Ping",
						parameters: Type.Object({ value: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "required",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			tool_choice: "required",
			tools: [expect.objectContaining({ name: "ping" })],
		});
	});

	it.each([
		"gpt-5.1",
		"gpt-5.2",
		"gpt-5.3-codex",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.4-nano",
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
	] as const)("sends none reasoning effort for OpenAI %s when no reasoning is requested", async (modelId) => {
		const model = getModel("openai", modelId);
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "none" },
		});
	});

	it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const)(
		"omits reasoning effort for OpenAI %s when off is unsupported",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("enables provider storage only for opted-in official OpenAI continuation", async () => {
		let officialPayload: CapturedResponsesPayload | undefined;
		await captureOpenAIResponseHeaders({
			sessionId: "stateful-official",
			statefulResponses: true,
			onPayload: (payload) => {
				officialPayload = payload as CapturedResponsesPayload;
			},
		});
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
		};
		let proxyPayload: CapturedResponsesPayload | undefined;
		await captureOpenAIResponseHeaders(
			{
				sessionId: "stateful-proxy",
				statefulResponses: true,
				onPayload: (payload) => {
					proxyPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(officialPayload?.store).toBe(true);
		expect(proxyPayload?.store).toBe(false);
	});

	it("preserves the stateful continuation option through streamSimple", async () => {
		let capturedPayload: CapturedResponsesPayload | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const stream = streamSimpleOpenAIResponses(
			getModel("openai", "gpt-5.6-terra"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				sessionId: "stateful-simple",
				statefulResponses: true,
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
		);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.store).toBe(true);
	});

	it("sends only the uncovered input after an official response handle", async () => {
		const payloads: CapturedResponsesPayload[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			payloads.push(JSON.parse(String(init?.body)) as CapturedResponsesPayload);
			const responseId = `resp_${payloads.length}`;
			const sse = `data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: responseId,
					status: "completed",
					output: [],
					usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
				},
			})}\n\n`;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const model = getModel("openai", "gpt-5.6-terra");
		const first = await streamSimpleOpenAIResponses(
			model,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "one", timestamp: 1 }] },
			{ apiKey: "test-key", sessionId: "stateful-delta-proof", statefulResponses: true },
		).result();
		await streamSimpleOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [
					{ role: "user", content: "one", timestamp: 1 },
					first,
					{ role: "user", content: "two", timestamp: 2 },
				],
			},
			{ apiKey: "test-key", sessionId: "stateful-delta-proof", statefulResponses: true },
		).result();

		expect(payloads).toHaveLength(2);
		expect(payloads[0].previous_response_id).toBeUndefined();
		expect(payloads[1].previous_response_id).toBe("resp_1");
		expect(payloads[1].input).toHaveLength(1);
		expect(JSON.stringify(payloads[1].input)).toContain("two");
	});

	it("retries one pre-stream gateway failure with a byte-identical payload by default", async () => {
		const bodies: string[] = [];
		const requestHeaders: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			bodies.push(String(init?.body));
			requestHeaders.push(JSON.stringify([...new Headers(init?.headers).entries()]));
			if (bodies.length === 1) return new Response(null, { status: 502 });
			const sse = `data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_gateway_recovery",
					status: "completed",
					output: [],
					usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
				},
			})}\n\n`;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const result = await streamSimpleOpenAIResponses(
			getModel("openai", "gpt-5.6-terra"),
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "test-key", sessionId: "gateway-retry-proof" },
		).result();

		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
		expect(requestHeaders[1]).toBe(requestHeaders[0]);
		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.at(-1)).toMatchObject({
			type: "provider_request_retry",
			details: { attempts: 1, status: "success" },
		});
	});

	it("does not apply the default gateway retry to rate limits", async () => {
		let requests = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			requests++;
			return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		});

		const result = await streamSimpleOpenAIResponses(
			getModel("openai", "gpt-5.6-terra"),
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "test-key", sessionId: "gateway-retry-no-429" },
		).result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("reports a failed default gateway retry without retaining the error body", async () => {
		let requests = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			requests++;
			return new Response("private gateway failure", { status: 502 });
		});

		const result = await streamSimpleOpenAIResponses(
			getModel("openai", "gpt-5.6-terra"),
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "test-key", sessionId: "gateway-retry-failure" },
		).result();

		expect(requests).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics?.at(-1)).toMatchObject({
			type: "provider_request_retry",
			details: { attempts: 1, status: "failed" },
		});
		expect(JSON.stringify(result.diagnostics)).not.toContain("private gateway failure");
	});

	it("falls back to store false when official response storage is rejected", async () => {
		const stores: boolean[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const payload = JSON.parse(String(init?.body)) as CapturedResponsesPayload;
			stores.push(payload.store ?? false);
			if (stores.length === 1) {
				return new Response(
					JSON.stringify({
						error: { message: "store is unavailable under zero data retention", type: "invalid_request_error" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			const sse = `data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_fallback",
					status: "completed",
					output: [],
					usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
				},
			})}\n\n`;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const result = await streamSimpleOpenAIResponses(
			getModel("openai", "gpt-5.6-terra"),
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key", sessionId: "stateful-zdr-fallback", statefulResponses: true, maxRetries: 0 },
		).result();

		expect(stores).toEqual([true, false]);
		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.at(-1)?.details?.status).toBe("fallback");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		let capturedPayload: Pick<CapturedResponsesPayload, "prompt_cache_key"> | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				sessionId,
				onPayload: (payload) => {
					capturedPayload = payload as Pick<CapturedResponsesPayload, "prompt_cache_key">;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("uses OpenRouter session-affinity header when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openrouter" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-proxy");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("auto-detects OpenRouter session-affinity header for OpenRouter Responses endpoints", async () => {
		const openRouterModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-openrouter",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			openRouterModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-openrouter");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-openrouter");
	});

	it("uses OpenAI no-session format when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-proxy");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("uses OpenAI no-session format for OpenCode Responses models", async () => {
		const model = getModel("opencode", "gpt-5.4");
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-opencode",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			model,
		);

		expect(model.compat?.sessionAffinityFormat).toBe("openai-nosession");
		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-opencode");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.prompt_cache_key).toBe("session-opencode");
	});

	it("can omit OpenAI session_id header while preserving other affinity data", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-123",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-123");
		expect(capturedPayload?.prompt_cache_key).toBe("session-123");
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it.each([
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.5", "flex", 0.5],
	] as const)("applies %s %s service-tier cost multiplier", async (modelId, serviceTier, multiplier) => {
		const model = getModel("openai", modelId);
		const tokenCount = 100_000;
		const tokenScale = tokenCount / 1_000_000;
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: serviceTier,
					usage: {
						input_tokens: tokenCount,
						output_tokens: tokenCount,
						total_tokens: tokenCount * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", serviceTier },
		);

		const result = await stream.result();

		expect(result.usage.cost.input).toBe(model.cost.input * multiplier * tokenScale);
		expect(result.usage.cost.output).toBe(model.cost.output * multiplier * tokenScale);
		expect(result.usage.cost.total).toBe((model.cost.input + model.cost.output) * multiplier * tokenScale);
	});

	it.each([
		["official input details", { input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 } }],
		[
			"chat-completions compatible details",
			{ prompt_tokens_details: { cached_tokens: 600, cache_creation_tokens: 100 } },
		],
		["anthropic-compatible top-level aliases", { cache_read_input_tokens: 600, cache_creation_input_tokens: 100 }],
	] as const)("normalizes cache usage from %s", async (_label, usageDetails) => {
		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1_000,
					output_tokens: 20,
					total_tokens: 1_020,
					...usageDetails,
				},
			},
		})}\n\n`;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const result = await streamOpenAIResponses(
			getModel("openai", "gpt-5.6-terra"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key" },
		).result();

		expect(result.usage.input).toBe(300);
		expect(result.usage.cacheRead).toBe(600);
		expect(result.usage.cacheWrite).toBe(100);
		expect(result.usage.input + result.usage.cacheRead + result.usage.cacheWrite).toBe(1_000);
	});
});
