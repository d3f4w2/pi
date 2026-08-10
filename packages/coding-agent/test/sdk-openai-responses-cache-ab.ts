#!/usr/bin/env node
/**
 * Reproducible proof for cache-aware provider-context pruning.
 *
 * Dry-run mode captures exact OpenAI Responses payloads before network I/O and
 * fails unless cache-aware pruning preserves a longer original byte prefix than
 * legacy pruning. Live mode sends exactly three single-turn requests and treats
 * provider cache reuse as proven only when positive cacheRead usage is reported.
 */

import { createHash } from "node:crypto";
import process from "node:process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type Api,
	type AssistantMessage,
	type Context,
	getModel,
	type Model,
	Type,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { type OpenAIResponsesOptions, stream as streamOpenAIResponses } from "../../ai/src/api/openai-responses.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type ContextPruningStats, pruneContextToolOutputs } from "../src/core/context-hygiene.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

type Mode = "dry-run" | "live";
type VariantName = "original" | "cache-aware" | "legacy";

interface Args {
	mode: Mode;
	provider: string;
	model: string;
}

interface Fixture {
	systemPrompt: string;
	original: AgentMessage[];
	cacheAware: AgentMessage[];
	legacy: AgentMessage[];
	cacheAwareStats: ContextPruningStats;
	legacyStats: ContextPruningStats;
}

interface PayloadMeasurement {
	sha256: string;
	bytes: number;
	inputItems: number;
}

interface PrefixMeasurement {
	sharedBytes: number;
	changedSuffixBytes: number;
	sharedInputItems: number;
}

interface ClientProof {
	verdict: "proven";
	payloads: Record<VariantName, PayloadMeasurement>;
	prefixes: {
		cacheAware: PrefixMeasurement;
		legacy: PrefixMeasurement;
	};
	pruning: {
		cacheAware: ContextPruningStats;
		legacy: ContextPruningStats;
	};
}

interface LiveMeasurement {
	variant: VariantName;
	elapsedMs: number;
	ttftMs: number;
	stopReason: AssistantMessage["stopReason"];
	output: string;
	usage: Usage;
	payload: PayloadMeasurement;
}

type ServerCacheVerdict =
	| "proven-cache-aware-advantage"
	| "proven-equal-cache-read"
	| "proven-cache-aware-disadvantage"
	| "unproven-no-positive-cache-read"
	| "incomplete";

const DEFAULT_PROVIDER = "rayin-gpt";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_PROVIDER_REQUESTS = 3;
const EXPECTED_FINAL_TEXT = "CACHE_PREFIX_OK";
const SHARED_SESSION_ID = "context-cache-prefix-proof-v1";
const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function parseArgs(argv: string[]): Args {
	let mode: Mode = "dry-run";
	let provider = DEFAULT_PROVIDER;
	let model = DEFAULT_MODEL;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--dry-run":
				mode = "dry-run";
				break;
			case "--live":
				mode = "live";
				break;
			case "--provider": {
				const value = argv[++i];
				if (!value) throw new Error("Missing value for --provider");
				provider = value;
				break;
			}
			case "--model": {
				const value = argv[++i];
				if (!value) throw new Error("Missing value for --model");
				model = value;
				break;
			}
			case "--help":
				console.log(`Usage: node test/sdk-openai-responses-cache-ab.ts [options]

Options:
  --dry-run             Prove exact provider-payload prefix preservation without network access (default)
  --live                Send exactly three requests: original, cache-aware, legacy
  --provider <id>       Configured provider id (default: ${DEFAULT_PROVIDER})
  --model <id>          Configured model id (default: ${DEFAULT_MODEL})
  --help                Show this help
`);
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return { mode, provider, model };
}

function assistantToolCall(id: string, path: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		api: "openai-responses",
		provider: "cache-proof",
		model: "cache-proof",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(id: string, output: string, timestamp: number): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp,
	};
}

function exchange(id: string, path: string, output: string, timestamp: number): AgentMessage[] {
	return [assistantToolCall(id, path, timestamp), toolResult(id, output, timestamp + 1)];
}

function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function buildFixture(): Fixture {
	const deepOld = `deep-old-${"a".repeat(8_000)}`;
	const deepNew = `deep-new-${"b".repeat(8_000)}`;
	const tailOld = `tail-old-${"c".repeat(8_000)}`;
	const tailNew = `tail-new-${"d".repeat(8_000)}`;
	const systemLines = [
		"This is a deterministic provider-prefix cache experiment.",
		`Reply to the final user message with exactly ${EXPECTED_FINAL_TEXT}.`,
		"Do not call tools for the final user message.",
	];
	for (let i = 1; i <= 100; i++) {
		systemLines.push(
			`Stable instruction ${String(i).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.`,
		);
	}

	const original: AgentMessage[] = [
		{ role: "user", content: "Begin deterministic cache-prefix fixture.", timestamp: 1 },
		...exchange("deep-old", "src/deep.ts", deepOld, 2),
		...exchange("deep-new", "src/deep.ts", deepNew, 4),
		{ role: "user", content: `stable-middle-${"m".repeat(40_000)}`, timestamp: 6 },
		...exchange("tail-old", "src/tail.ts", tailOld, 7),
		...exchange("tail-new", "src/tail.ts", tailNew, 9),
		{ role: "user", content: `Reply with exactly ${EXPECTED_FINAL_TEXT}. Do not call tools.`, timestamp: 11 },
	];
	const commonSettings = {
		protectRecentTokens: 1,
		minimumSavingsTokens: 1,
		minimumResultTokens: 1,
		previewCharacters: 24,
	};
	const cacheAware = pruneContextToolOutputs(original, { ...commonSettings, cacheWarmSuffixTokens: 8_000 });
	const legacy = pruneContextToolOutputs(original, { ...commonSettings, cacheWarmSuffixTokens: 0 });

	if (resultText(cacheAware.messages[2]!) !== deepOld) {
		throw new Error("Cache-aware pruning changed the deep result");
	}
	if (!resultText(cacheAware.messages[7]!).includes("newer result for the same read request")) {
		throw new Error("Cache-aware pruning did not remove the tail duplicate");
	}
	if (!resultText(legacy.messages[2]!).includes("newer result for the same read request")) {
		throw new Error("Legacy pruning did not rewrite the deep duplicate");
	}
	if (cacheAware.stats.cacheProtectedResults < 1 || cacheAware.stats.prunedResults !== 1) {
		throw new Error("Cache-aware pruning statistics do not prove one protected deep result and one tail rewrite");
	}
	if (legacy.stats.prunedResults < 2) {
		throw new Error(`Legacy pruning did not rewrite the deep and tail candidates: ${JSON.stringify(legacy.stats)}`);
	}

	return {
		systemPrompt: systemLines.join("\n"),
		original,
		cacheAware: cacheAware.messages,
		legacy: legacy.messages,
		cacheAwareStats: cacheAware.stats,
		legacyStats: legacy.stats,
	};
}

const readParameters = Type.Object({
	path: Type.String({ description: "Path read by the recorded historical tool call" }),
});

function buildContext(systemPrompt: string, messages: AgentMessage[]): Context {
	const providerMessages = messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
	if (providerMessages.length !== messages.length) {
		throw new Error("Experiment fixture contains a non-provider message");
	}
	return {
		systemPrompt,
		messages: providerMessages,
		tools: [
			{
				name: "read",
				description: "Historical deterministic read fixture. Do not call it for the final request.",
				parameters: readParameters,
			},
		],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializePayload(payload: unknown): string {
	if (!isRecord(payload)) throw new Error("Provider payload is not an object");
	return JSON.stringify(payload);
}

function payloadMeasurement(payload: unknown): PayloadMeasurement {
	const serialized = serializePayload(payload);
	const input = isRecord(payload) && Array.isArray(payload.input) ? payload.input : [];
	return {
		sha256: createHash("sha256").update(serialized).digest("hex"),
		bytes: Buffer.byteLength(serialized),
		inputItems: input.length,
	};
}

function longestCommonPrefixBytes(left: string, right: string): number {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	const limit = Math.min(leftBytes.length, rightBytes.length);
	let index = 0;
	while (index < limit && leftBytes[index] === rightBytes[index]) index++;
	return index;
}

function sharedInputItems(left: unknown, right: unknown): number {
	if (!isRecord(left) || !isRecord(right) || !Array.isArray(left.input) || !Array.isArray(right.input)) return 0;
	const limit = Math.min(left.input.length, right.input.length);
	let index = 0;
	while (index < limit && JSON.stringify(left.input[index]) === JSON.stringify(right.input[index])) index++;
	return index;
}

function prefixMeasurement(original: unknown, variant: unknown): PrefixMeasurement {
	const originalSerialized = serializePayload(original);
	const sharedBytes = longestCommonPrefixBytes(originalSerialized, serializePayload(variant));
	return {
		sharedBytes,
		changedSuffixBytes: Buffer.byteLength(originalSerialized) - sharedBytes,
		sharedInputItems: sharedInputItems(original, variant),
	};
}

async function capturePayload(model: Model<"openai-responses">, context: Context): Promise<unknown> {
	let captured: unknown;
	const stream = streamOpenAIResponses(model, context, {
		apiKey: "dry-run-key",
		cacheRetention: "short",
		maxRetries: 0,
		maxTokens: 32,
		reasoningEffort: "minimal",
		sessionId: SHARED_SESSION_ID,
		onPayload: (payload) => {
			captured = structuredClone(payload);
			throw new Error("dry-run payload captured");
		},
	});
	for await (const _event of stream) {
		// Consuming the error event completes the no-network capture.
	}
	if (captured === undefined) throw new Error("Dry-run did not capture a payload");
	return captured;
}

async function proveClientPrefix(fixture: Fixture): Promise<ClientProof> {
	const model = getModel("openai", "gpt-5.6-sol");
	if (!model || model.api !== "openai-responses") throw new Error("OpenAI Responses fixture model unavailable");
	const variants: Array<[VariantName, AgentMessage[]]> = [
		["original", fixture.original],
		["cache-aware", fixture.cacheAware],
		["legacy", fixture.legacy],
	];
	const payloads = new Map<VariantName, unknown>();
	for (const [name, messages] of variants) {
		payloads.set(name, await capturePayload(model, buildContext(fixture.systemPrompt, messages)));
	}
	const original = payloads.get("original");
	const cacheAware = payloads.get("cache-aware");
	const legacy = payloads.get("legacy");
	if (original === undefined || cacheAware === undefined || legacy === undefined) {
		throw new Error("Missing a captured provider payload");
	}
	const cacheAwarePrefix = prefixMeasurement(original, cacheAware);
	const legacyPrefix = prefixMeasurement(original, legacy);
	if (cacheAwarePrefix.sharedBytes <= legacyPrefix.sharedBytes) {
		throw new Error("Cache-aware pruning did not preserve a longer provider-payload byte prefix");
	}
	if (cacheAwarePrefix.sharedInputItems <= legacyPrefix.sharedInputItems) {
		throw new Error("Cache-aware pruning did not preserve more complete provider input items");
	}

	return {
		verdict: "proven",
		payloads: {
			original: payloadMeasurement(original),
			"cache-aware": payloadMeasurement(cacheAware),
			legacy: payloadMeasurement(legacy),
		},
		prefixes: { cacheAware: cacheAwarePrefix, legacy: legacyPrefix },
		pruning: { cacheAware: fixture.cacheAwareStats, legacy: fixture.legacyStats },
	};
}

function getText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

async function completeMeasured(
	variant: VariantName,
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions,
): Promise<LiveMeasurement> {
	let payload: unknown;
	let message: AssistantMessage | undefined;
	let ttftMs: number | undefined;
	const startedAt = Date.now();
	const stream = streamOpenAIResponses(model, context, {
		...options,
		onPayload: (requestPayload) => {
			payload = structuredClone(requestPayload);
		},
	});

	for await (const event of stream) {
		if (
			ttftMs === undefined &&
			(event.type === "thinking_start" || event.type === "text_start" || event.type === "toolcall_start")
		) {
			ttftMs = Date.now() - startedAt;
		}
		if (event.type === "done") message = event.message;
		if (event.type === "error") throw new Error(event.error.errorMessage ?? `${variant} request failed`);
	}

	if (!message) throw new Error(`${variant} request ended without a completed assistant message`);
	if (payload === undefined) throw new Error(`${variant} request did not expose its payload`);
	const output = getText(message);
	if (output !== EXPECTED_FINAL_TEXT) {
		throw new Error(`${variant} returned unexpected final text: ${JSON.stringify(output)}`);
	}
	return {
		variant,
		elapsedMs: Date.now() - startedAt,
		ttftMs: ttftMs ?? Date.now() - startedAt,
		stopReason: message.stopReason,
		output,
		usage: message.usage,
		payload: payloadMeasurement(payload),
	};
}

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]");
}

function classifyServerCache(
	cacheAware: LiveMeasurement | undefined,
	legacy: LiveMeasurement | undefined,
): ServerCacheVerdict {
	if (!cacheAware || !legacy) return "incomplete";
	if (cacheAware.usage.cacheRead > legacy.usage.cacheRead) return "proven-cache-aware-advantage";
	if (cacheAware.usage.cacheRead < legacy.usage.cacheRead) return "proven-cache-aware-disadvantage";
	if (cacheAware.usage.cacheRead > 0) return "proven-equal-cache-read";
	return "unproven-no-positive-cache-read";
}

async function runLive(args: Args, fixture: Fixture, clientProof: ClientProof): Promise<void> {
	const authStorage = AuthStorage.create();
	const registry = await createModelRegistry(authStorage);
	const candidate = registry.find(args.provider, args.model);
	if (!candidate) throw new Error(`Model not found: ${args.provider}/${args.model}`);
	if (candidate.api !== "openai-responses") {
		throw new Error(`Expected openai-responses, received ${candidate.api}`);
	}
	const resolved = await registry.getApiKeyAndHeaders(candidate as Model<Api>);
	if (!resolved.ok) throw new Error(resolved.error);
	const model = (
		resolved.baseUrl ? { ...candidate, baseUrl: resolved.baseUrl } : candidate
	) as Model<"openai-responses">;
	const options: OpenAIResponsesOptions = {
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		cacheRetention: "short",
		maxRetries: 0,
		maxTokens: 32,
		reasoningEffort: "minimal",
		sessionId: `${SHARED_SESSION_ID}-${Date.now()}`,
		timeoutMs: 60_000,
	};
	const variants: Array<[VariantName, AgentMessage[]]> = [
		["original", fixture.original],
		["cache-aware", fixture.cacheAware],
		["legacy", fixture.legacy],
	];
	if (variants.length !== MAX_PROVIDER_REQUESTS) throw new Error("Live experiment request limit invariant failed");

	const measurements: LiveMeasurement[] = [];
	let attemptedRequests = 0;
	let error: string | undefined;
	for (const [variant, messages] of variants) {
		if (attemptedRequests >= MAX_PROVIDER_REQUESTS) {
			error = "Provider request limit reached";
			break;
		}
		attemptedRequests++;
		try {
			measurements.push(
				await completeMeasured(variant, model, buildContext(fixture.systemPrompt, messages), options),
			);
		} catch (requestError) {
			error = sanitizeError(requestError);
			break;
		}
	}

	const cacheAware = measurements.find((measurement) => measurement.variant === "cache-aware");
	const legacy = measurements.find((measurement) => measurement.variant === "legacy");
	const serverCacheVerdict = classifyServerCache(cacheAware, legacy);
	const comparison =
		cacheAware && legacy
			? {
					cacheReadDelta: cacheAware.usage.cacheRead - legacy.usage.cacheRead,
					uncachedInputDelta: cacheAware.usage.input - legacy.usage.input,
					ttftDeltaMs: cacheAware.ttftMs - legacy.ttftMs,
				}
			: undefined;
	console.log(
		JSON.stringify(
			{
				mode: "live",
				provider: args.provider,
				model: args.model,
				requestLimit: MAX_PROVIDER_REQUESTS,
				attemptedRequests,
				clientPrefixProof: clientProof,
				serverCacheVerdict,
				comparison,
				measurements,
				error,
			},
			null,
			2,
		),
	);
	if (error || attemptedRequests !== MAX_PROVIDER_REQUESTS || measurements.length !== MAX_PROVIDER_REQUESTS) {
		process.exitCode = 1;
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const fixture = buildFixture();
	const clientProof = await proveClientPrefix(fixture);
	if (args.mode === "dry-run") {
		console.log(JSON.stringify({ mode: "dry-run", clientPrefixProof: clientProof }, null, 2));
		return;
	}
	await runLive(args, fixture, clientProof);
}

main().catch((error: unknown) => {
	console.error(sanitizeError(error));
	process.exitCode = 1;
});
