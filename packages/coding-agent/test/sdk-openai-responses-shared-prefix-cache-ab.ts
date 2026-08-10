#!/usr/bin/env node
/**
 * Bounded live proof for project-scoped stable-prefix prompt-cache routing.
 *
 * Dry-run mode proves that the three outbound payloads differ only by
 * prompt_cache_key. Live mode sends exactly three requests with retries
 * disabled: optimized warm-up, session-key control, optimized cross-session hit.
 */

import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import type { Message } from "@earendil-works/pi-ai";
import {
	type Api,
	type AssistantMessage,
	type Context,
	getModel,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { type OpenAIResponsesOptions, stream as streamOpenAIResponses } from "../../ai/src/api/openai-responses.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	optimizeOpenAIResponsesPromptCache,
	type PromptCacheOptimizationDiagnostic,
} from "../src/core/prompt-cache-optimizer.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

type Mode = "dry-run" | "live";
type VariantName = "optimized-warm" | "session-key-control" | "optimized-hit";
type Verdict =
	| "proven-routing-advantage"
	| "proven-equal-cache-reuse"
	| "proven-routing-disadvantage"
	| "no-observed-cache-advantage"
	| "unsupported-or-incomplete";

interface Args {
	mode: Mode;
	provider: string;
	model: string;
}

interface Variant {
	name: VariantName;
	sessionId: string;
	applyOptimization: boolean;
}

interface PreparedPayload {
	payload: unknown;
	diagnostic: PromptCacheOptimizationDiagnostic;
}

interface PayloadSummary {
	sha256: string;
	normalizedSha256: string;
	bytes: number;
	cacheKeySha256: string;
	cacheKeyCharacters: number;
	stableShapeSha256: string;
	stableShapeBytes: number;
}

interface DryRunProof {
	verdict: "proven";
	payloads: Record<VariantName, PayloadSummary>;
}

interface UsageSummary {
	uncachedInputTokens: number;
	cacheReadTokens: number;
	promptTokens: number;
	cacheReadRatePercent: number;
	outputTokens: number;
	totalTokens: number;
}

interface LiveMeasurement {
	variant: VariantName;
	elapsedMs: number;
	ttftMs: number;
	stopReason: AssistantMessage["stopReason"];
	output: string;
	usage: UsageSummary;
	payload: PayloadSummary;
}

interface Comparison {
	cacheReadLiftTokens: number;
	cacheReadRateDeltaPoints: number;
	uncachedInputReductionTokens: number;
	uncachedInputReductionPercent: number;
	ttftReductionMs: number;
	ttftReductionPercent: number;
	elapsedReductionMs: number;
	elapsedReductionPercent: number;
}

const DEFAULT_PROVIDER = "rayin-gpt";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_PROVIDER_REQUESTS = 3;
const EXPECTED_FINAL_TEXT = "CACHE_ROUTE_OK";
const PROJECT_SCOPE = "pi-shared-prefix-cache-routing-live-proof";

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
				console.log(`Usage: node test/sdk-openai-responses-shared-prefix-cache-ab.ts [options]

Options:
  --dry-run             Prove payload equivalence without network access (default)
  --live                Send exactly three bounded provider requests
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

function buildSystemPrompt(runId: string): string {
	const lines = [
		"This is a deterministic stable-prefix cache-routing experiment.",
		`Experiment nonce: ${runId}.`,
		`Reply to the user with exactly ${EXPECTED_FINAL_TEXT}.`,
		"Do not call tools and do not add punctuation or explanation.",
	];
	for (let i = 1; i <= 160; i++) {
		lines.push(
			`Stable instruction ${String(i).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.`,
		);
	}
	return lines.join("\n");
}

function buildContext(systemPrompt: string): Context {
	const messages: Message[] = [{ role: "user", content: `Reply with exactly ${EXPECTED_FINAL_TEXT}.`, timestamp: 1 }];
	return { systemPrompt, messages };
}

function variants(runId: string): Variant[] {
	return [
		{ name: "optimized-warm", sessionId: `routing-warm-${runId}`, applyOptimization: true },
		{ name: "session-key-control", sessionId: `routing-control-${runId}`, applyOptimization: false },
		{ name: "optimized-hit", sessionId: `routing-hit-${runId}`, applyOptimization: true },
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializePayload(payload: unknown): string {
	if (!isRecord(payload)) throw new Error("Provider payload is not an object");
	return JSON.stringify(payload);
}

function preparePayload(
	payload: unknown,
	model: Model<"openai-responses">,
	applyOptimization: boolean,
): PreparedPayload {
	const optimized = optimizeOpenAIResponsesPromptCache(payload, model, PROJECT_SCOPE);
	if (
		optimized.diagnostic.reason !== "optimized" ||
		optimized.diagnostic.stableShapeSha256 === undefined ||
		optimized.diagnostic.stableShapeBytes === undefined
	) {
		throw new Error(`Cache optimizer did not produce a stable key: ${optimized.diagnostic.reason}`);
	}
	return {
		payload: applyOptimization ? optimized.payload : payload,
		diagnostic: optimized.diagnostic,
	};
}

function payloadSummary(prepared: PreparedPayload): PayloadSummary {
	if (!isRecord(prepared.payload)) throw new Error("Prepared payload is not an object");
	const cacheKey = prepared.payload.prompt_cache_key;
	if (typeof cacheKey !== "string" || cacheKey.length === 0) {
		throw new Error("Prepared payload has no prompt_cache_key");
	}
	const stableShapeSha256 = prepared.diagnostic.stableShapeSha256;
	const stableShapeBytes = prepared.diagnostic.stableShapeBytes;
	if (stableShapeSha256 === undefined || stableShapeBytes === undefined) {
		throw new Error("Prepared payload has no stable-shape evidence");
	}
	const serialized = serializePayload(prepared.payload);
	const normalized = serializePayload({ ...prepared.payload, prompt_cache_key: "[CACHE_KEY]" });
	return {
		sha256: createHash("sha256").update(serialized).digest("hex"),
		normalizedSha256: createHash("sha256").update(normalized).digest("hex"),
		bytes: Buffer.byteLength(serialized),
		cacheKeySha256: createHash("sha256").update(cacheKey).digest("hex"),
		cacheKeyCharacters: cacheKey.length,
		stableShapeSha256,
		stableShapeBytes,
	};
}

async function capturePayload(
	model: Model<"openai-responses">,
	context: Context,
	variant: Variant,
): Promise<PreparedPayload> {
	let captured: PreparedPayload | undefined;
	const stream = streamOpenAIResponses(model, context, {
		apiKey: "dry-run-key",
		cacheRetention: "short",
		maxRetries: 0,
		maxTokens: 16,
		reasoningEffort: "minimal",
		sessionId: variant.sessionId,
		onPayload: (payload) => {
			captured = preparePayload(payload, model, variant.applyOptimization);
			throw new Error("dry-run payload captured");
		},
	});
	for await (const _event of stream) {
		// Consuming the error event completes the no-network capture.
	}
	if (captured === undefined) throw new Error("Dry-run did not capture a payload");
	return captured;
}

async function proveDryRun(runId: string): Promise<DryRunProof> {
	const model = getModel("openai", "gpt-5.6-sol");
	if (!model || model.api !== "openai-responses") throw new Error("OpenAI Responses fixture model unavailable");
	const context = buildContext(buildSystemPrompt(runId));
	const captured = new Map<VariantName, PreparedPayload>();
	for (const variant of variants(runId)) {
		captured.set(variant.name, await capturePayload(model, context, variant));
	}

	const warm = captured.get("optimized-warm");
	const control = captured.get("session-key-control");
	const hit = captured.get("optimized-hit");
	if (!warm || !control || !hit) throw new Error("Dry-run did not capture all three variants");
	const summaries = {
		"optimized-warm": payloadSummary(warm),
		"session-key-control": payloadSummary(control),
		"optimized-hit": payloadSummary(hit),
	};

	if (new Set(Object.values(summaries).map((summary) => summary.normalizedSha256)).size !== 1) {
		throw new Error("Payloads differ in fields other than prompt_cache_key");
	}
	if (summaries["optimized-warm"].cacheKeySha256 !== summaries["optimized-hit"].cacheKeySha256) {
		throw new Error("Optimized cross-session requests do not share a cache key");
	}
	if (summaries["optimized-warm"].cacheKeySha256 === summaries["session-key-control"].cacheKeySha256) {
		throw new Error("Session-key control unexpectedly shares the optimized cache key");
	}
	if (new Set(Object.values(summaries).map((summary) => summary.stableShapeSha256)).size !== 1) {
		throw new Error("Stable cache shape differs across variants");
	}
	if (Object.values(summaries).some((summary) => summary.cacheKeyCharacters > 64)) {
		throw new Error("A prompt cache key exceeds the provider limit");
	}
	if (Math.min(...Object.values(summaries).map((summary) => summary.bytes)) < 16_000) {
		throw new Error("Stable prompt is too small for a meaningful cache experiment");
	}

	return { verdict: "proven", payloads: summaries };
}

function getText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function summarizeUsage(usage: Usage): UsageSummary {
	const promptTokens = usage.input + usage.cacheRead;
	return {
		uncachedInputTokens: usage.input,
		cacheReadTokens: usage.cacheRead,
		promptTokens,
		cacheReadRatePercent: promptTokens === 0 ? 0 : (usage.cacheRead / promptTokens) * 100,
		outputTokens: usage.output,
		totalTokens: usage.totalTokens,
	};
}

async function completeMeasured(
	variant: Variant,
	model: Model<"openai-responses">,
	context: Context,
	options: Omit<OpenAIResponsesOptions, "sessionId">,
): Promise<LiveMeasurement> {
	let prepared: PreparedPayload | undefined;
	let message: AssistantMessage | undefined;
	let ttftMs: number | undefined;
	const startedAt = Date.now();
	const stream = streamOpenAIResponses(model, context, {
		...options,
		sessionId: variant.sessionId,
		onPayload: (payload) => {
			prepared = preparePayload(payload, model, variant.applyOptimization);
			return prepared.payload;
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
		if (event.type === "error") throw new Error(event.error.errorMessage ?? `${variant.name} request failed`);
	}

	if (!message) throw new Error(`${variant.name} request ended without a completed assistant message`);
	if (!prepared) throw new Error(`${variant.name} request did not expose its payload`);
	const output = getText(message);
	if (output !== EXPECTED_FINAL_TEXT) {
		throw new Error(`${variant.name} returned unexpected final text: ${JSON.stringify(output)}`);
	}
	return {
		variant: variant.name,
		elapsedMs: Date.now() - startedAt,
		ttftMs: ttftMs ?? Date.now() - startedAt,
		stopReason: message.stopReason,
		output,
		usage: summarizeUsage(message.usage),
		payload: payloadSummary(prepared),
	};
}

function percentage(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function compare(control: LiveMeasurement, hit: LiveMeasurement): Comparison {
	const uncachedInputReductionTokens = control.usage.uncachedInputTokens - hit.usage.uncachedInputTokens;
	const ttftReductionMs = control.ttftMs - hit.ttftMs;
	const elapsedReductionMs = control.elapsedMs - hit.elapsedMs;
	return {
		cacheReadLiftTokens: hit.usage.cacheReadTokens - control.usage.cacheReadTokens,
		cacheReadRateDeltaPoints: hit.usage.cacheReadRatePercent - control.usage.cacheReadRatePercent,
		uncachedInputReductionTokens,
		uncachedInputReductionPercent: percentage(uncachedInputReductionTokens, control.usage.uncachedInputTokens),
		ttftReductionMs,
		ttftReductionPercent: percentage(ttftReductionMs, control.ttftMs),
		elapsedReductionMs,
		elapsedReductionPercent: percentage(elapsedReductionMs, control.elapsedMs),
	};
}

function classify(control: LiveMeasurement | undefined, hit: LiveMeasurement | undefined): Verdict {
	if (!control || !hit) return "unsupported-or-incomplete";
	if (
		hit.usage.cacheReadTokens > control.usage.cacheReadTokens &&
		hit.usage.uncachedInputTokens < control.usage.uncachedInputTokens
	) {
		return "proven-routing-advantage";
	}
	if (
		hit.usage.cacheReadTokens === control.usage.cacheReadTokens &&
		hit.usage.cacheReadTokens > 0 &&
		hit.usage.uncachedInputTokens === control.usage.uncachedInputTokens
	) {
		return "proven-equal-cache-reuse";
	}
	if (
		hit.usage.cacheReadTokens < control.usage.cacheReadTokens ||
		hit.usage.uncachedInputTokens > control.usage.uncachedInputTokens
	) {
		return "proven-routing-disadvantage";
	}
	return "no-observed-cache-advantage";
}

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]");
}

async function runLive(args: Args): Promise<void> {
	const runId = randomUUID();
	const dryRunProof = await proveDryRun(runId);
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
	const options: Omit<OpenAIResponsesOptions, "sessionId"> = {
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		env: resolved.env,
		cacheRetention: "short",
		maxRetries: 0,
		maxTokens: 16,
		reasoningEffort: "minimal",
		timeoutMs: 60_000,
	};
	const experimentVariants = variants(runId);
	if (experimentVariants.length !== MAX_PROVIDER_REQUESTS) {
		throw new Error("Live experiment request limit invariant failed");
	}

	const context = buildContext(buildSystemPrompt(runId));
	const measurements: LiveMeasurement[] = [];
	let attemptedRequests = 0;
	let error: string | undefined;
	for (const variant of experimentVariants) {
		if (attemptedRequests >= MAX_PROVIDER_REQUESTS) {
			error = "Provider request limit reached";
			break;
		}
		attemptedRequests++;
		try {
			measurements.push(await completeMeasured(variant, model, context, options));
		} catch (requestError) {
			error = sanitizeError(requestError);
			break;
		}
	}

	const control = measurements.find((measurement) => measurement.variant === "session-key-control");
	const hit = measurements.find((measurement) => measurement.variant === "optimized-hit");
	console.log(
		JSON.stringify(
			{
				mode: "live",
				provider: args.provider,
				model: args.model,
				experimentIdSha256: createHash("sha256").update(runId).digest("hex"),
				requestLimit: MAX_PROVIDER_REQUESTS,
				attemptedRequests,
				dryRunProof,
				verdict: classify(control, hit),
				comparison: control && hit ? compare(control, hit) : undefined,
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
	if (args.mode === "dry-run") {
		console.log(JSON.stringify({ mode: "dry-run", dryRunProof: await proveDryRun("dry-run-v1") }, null, 2));
		return;
	}
	await runLive(args);
}

main().catch((error: unknown) => {
	console.error(sanitizeError(error));
	process.exitCode = 1;
});
