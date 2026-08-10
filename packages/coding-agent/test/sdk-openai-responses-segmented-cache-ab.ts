#!/usr/bin/env node
/**
 * Bounded live proof for segmented GPT-5.6 prompt caching.
 *
 * The control and explicit-hit requests have identical model-visible content.
 * The explicit warm and hit requests share only the stable base while both the
 * dynamic system suffix and user message change. Live mode makes at most three
 * provider attempts, disables retries, and stops after the first error.
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
	type OpenAIResponsesCompat,
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
type VariantName = "implicit-control" | "explicit-warm" | "explicit-hit";
type Verdict =
	| "proven-dynamic-prefix-reuse"
	| "provider-rejected-explicit-breakpoint"
	| "no-observed-dynamic-prefix-reuse"
	| "unsupported-or-incomplete";

interface Args {
	mode: Mode;
	provider: string;
	model: string;
}

interface Variant {
	name: VariantName;
	sessionId: string;
	explicit: boolean;
	dynamicLabel: "A" | "B";
}

interface PreparedPayload {
	payload: unknown;
	diagnostic: PromptCacheOptimizationDiagnostic;
}

interface PayloadSummary {
	sha256: string;
	canonicalVisibleSha256: string;
	bytes: number;
	cacheKeySha256: string;
	cacheKeyCharacters: number;
	stableShapeSha256: string;
	stableSystemPromptSha256: string;
	fullSystemPromptSha256: string;
	stableSystemPromptBytes: number;
	dynamicSystemPromptBytes: number;
	breakpointOffsetBytes?: number;
	explicitBreakpoint: PromptCacheOptimizationDiagnostic["explicitBreakpoint"];
}

interface DryRunProof {
	verdict: "proven";
	payloads: Record<VariantName, PayloadSummary>;
}

interface UsageSummary {
	uncachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
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
	cacheWriteDeltaTokens: number;
	uncachedInputReductionTokens: number;
	uncachedInputReductionPercent: number;
	cacheReadRateDeltaPoints: number;
	ttftReductionMs: number;
	ttftReductionPercent: number;
	elapsedReductionMs: number;
	elapsedReductionPercent: number;
}

const DEFAULT_PROVIDER = "rayin-gpt";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_PROVIDER_REQUESTS = 3;
const EXPECTED_FINAL_TEXT = "CACHE_SEGMENT_OK";
const PROJECT_SCOPE = "pi-segmented-prompt-cache-live-proof";

function parseArgs(argv: string[]): Args {
	let mode: Mode = "dry-run";
	let provider = DEFAULT_PROVIDER;
	let model = DEFAULT_MODEL;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--dry-run") mode = "dry-run";
		else if (arg === "--live") mode = "live";
		else if (arg === "--provider") {
			const value = argv[++index];
			if (!value) throw new Error("Missing value for --provider");
			provider = value;
		} else if (arg === "--model") {
			const value = argv[++index];
			if (!value) throw new Error("Missing value for --model");
			model = value;
		} else if (arg === "--help") {
			console.log(`Usage: node test/sdk-openai-responses-segmented-cache-ab.ts [options]

Options:
  --dry-run             Prove segmentation without network access (default)
  --live                Send at most three bounded provider requests
  --provider <id>       Configured provider id (default: ${DEFAULT_PROVIDER})
  --model <id>          Configured model id (default: ${DEFAULT_MODEL})
  --help                Show this help
`);
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	return { mode, provider, model };
}

function variants(runId: string): Variant[] {
	return [
		{ name: "implicit-control", sessionId: `segment-control-${runId}`, explicit: false, dynamicLabel: "B" },
		{ name: "explicit-warm", sessionId: `segment-warm-${runId}`, explicit: true, dynamicLabel: "A" },
		{ name: "explicit-hit", sessionId: `segment-hit-${runId}`, explicit: true, dynamicLabel: "B" },
	];
}

function buildStableSystemPrompt(runId: string): string {
	const lines = [
		"This is a deterministic segmented prompt-cache experiment.",
		`Experiment nonce: ${runId}.`,
		`Reply to the user with exactly ${EXPECTED_FINAL_TEXT}.`,
		"Do not call tools and do not add punctuation or explanation.",
	];
	for (let index = 1; index <= 180; index++) {
		lines.push(
			`Stable instruction ${String(index).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.`,
		);
	}
	return lines.join("\n");
}

function buildContext(stableSystemPrompt: string, dynamicLabel: "A" | "B"): Context {
	const systemPrompt = `${stableSystemPrompt}\n\n<dynamic_state>revision-${dynamicLabel}</dynamic_state>`;
	const messages: Message[] = [
		{
			role: "user",
			content: `Dynamic user suffix ${dynamicLabel}. Reply with exactly ${EXPECTED_FINAL_TEXT}.`,
			timestamp: dynamicLabel === "A" ? 1 : 2,
		},
	];
	return { systemPrompt, messages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function explicitModel(model: Model<"openai-responses">, enabled: boolean): Model<"openai-responses"> {
	const compat = model.compat as OpenAIResponsesCompat | undefined;
	return {
		...model,
		compat: {
			...compat,
			supportsExplicitPromptCacheMode: enabled,
			supportsPromptCacheBreakpoints: enabled,
		},
	};
}

function systemText(payload: Record<string, unknown>): string {
	if (!Array.isArray(payload.input) || !isRecord(payload.input[0])) throw new Error("Payload has no system message");
	const content = payload.input[0].content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) throw new Error("System content is not text");
	let text = "";
	for (const item of content) {
		if (!isRecord(item) || item.type !== "input_text" || typeof item.text !== "string") {
			throw new Error("System content contains a non-text block");
		}
		text += item.text;
	}
	return text;
}

function breakpointOffsetBytes(payload: Record<string, unknown>): number | undefined {
	if (!Array.isArray(payload.input) || !isRecord(payload.input[0]) || !Array.isArray(payload.input[0].content)) {
		return undefined;
	}
	let text = "";
	for (const item of payload.input[0].content) {
		if (!isRecord(item) || typeof item.text !== "string") return undefined;
		text += item.text;
		if (isRecord(item.prompt_cache_breakpoint) && item.prompt_cache_breakpoint.mode === "explicit") {
			return Buffer.byteLength(text);
		}
	}
	return undefined;
}

function canonicalVisiblePayload(payload: Record<string, unknown>): string {
	if (!Array.isArray(payload.input) || !isRecord(payload.input[0])) throw new Error("Payload has no input");
	const input = [...payload.input];
	input[0] = { ...payload.input[0], content: systemText(payload) };
	return JSON.stringify({
		...payload,
		input,
		prompt_cache_key: undefined,
		prompt_cache_options: undefined,
		prompt_cache_retention: undefined,
	});
}

function preparePayload(
	payload: unknown,
	model: Model<"openai-responses">,
	stableSystemPrompt: string,
	applyOptimization: boolean,
): PreparedPayload {
	const optimized = optimizeOpenAIResponsesPromptCache(payload, model, PROJECT_SCOPE, { stableSystemPrompt });
	if (optimized.diagnostic.reason !== "optimized") {
		throw new Error(`Cache optimizer failed: ${optimized.diagnostic.reason}`);
	}
	return {
		payload: applyOptimization ? optimized.payload : payload,
		diagnostic: optimized.diagnostic,
	};
}

function payloadSummary(prepared: PreparedPayload): PayloadSummary {
	if (!isRecord(prepared.payload)) throw new Error("Prepared payload is not an object");
	const cacheKey = prepared.payload.prompt_cache_key;
	const diagnostic = prepared.diagnostic;
	if (typeof cacheKey !== "string" || cacheKey.length === 0) throw new Error("Payload has no cache key");
	if (
		diagnostic.stableShapeSha256 === undefined ||
		diagnostic.stableSystemPromptSha256 === undefined ||
		diagnostic.fullSystemPromptSha256 === undefined ||
		diagnostic.stableSystemPromptBytes === undefined ||
		diagnostic.dynamicSystemPromptBytes === undefined
	) {
		throw new Error("Payload has incomplete stable-prefix diagnostics");
	}
	const serialized = JSON.stringify(prepared.payload);
	return {
		sha256: sha256(serialized),
		canonicalVisibleSha256: sha256(canonicalVisiblePayload(prepared.payload)),
		bytes: Buffer.byteLength(serialized),
		cacheKeySha256: sha256(cacheKey),
		cacheKeyCharacters: cacheKey.length,
		stableShapeSha256: diagnostic.stableShapeSha256,
		stableSystemPromptSha256: diagnostic.stableSystemPromptSha256,
		fullSystemPromptSha256: diagnostic.fullSystemPromptSha256,
		stableSystemPromptBytes: diagnostic.stableSystemPromptBytes,
		dynamicSystemPromptBytes: diagnostic.dynamicSystemPromptBytes,
		breakpointOffsetBytes: breakpointOffsetBytes(prepared.payload),
		explicitBreakpoint: diagnostic.explicitBreakpoint,
	};
}

async function capturePayload(
	baseModel: Model<"openai-responses">,
	stableSystemPrompt: string,
	variant: Variant,
): Promise<PreparedPayload> {
	const requestModel = explicitModel(baseModel, variant.explicit);
	const context = buildContext(stableSystemPrompt, variant.dynamicLabel);
	let captured: PreparedPayload | undefined;
	let captureError: string | undefined;
	const stream = streamOpenAIResponses(requestModel, context, {
		apiKey: "dry-run-key",
		cacheRetention: "short",
		maxRetries: 0,
		maxTokens: 16,
		reasoningEffort: "minimal",
		sessionId: variant.sessionId,
		onPayload: (payload) => {
			captured = preparePayload(payload, requestModel, stableSystemPrompt, variant.explicit);
			if (systemText(captured.payload as Record<string, unknown>) !== context.systemPrompt) {
				throw new Error("Segmented payload changed model-visible system text");
			}
			throw new Error("dry-run payload captured");
		},
	});
	for await (const event of stream) {
		if (event.type === "error") captureError = event.error.errorMessage;
	}
	if (!captured) throw new Error(captureError ?? "Dry-run did not capture a payload");
	return captured;
}

async function proveDryRun(runId: string): Promise<DryRunProof> {
	const baseModel = getModel("openai", "gpt-5.6-sol");
	if (!baseModel || baseModel.api !== "openai-responses") throw new Error("GPT-5.6 fixture unavailable");
	const stableSystemPrompt = buildStableSystemPrompt(runId);
	const captured = new Map<VariantName, PreparedPayload>();
	for (const variant of variants(runId)) {
		captured.set(variant.name, await capturePayload(baseModel, stableSystemPrompt, variant));
	}
	const control = captured.get("implicit-control");
	const warm = captured.get("explicit-warm");
	const hit = captured.get("explicit-hit");
	if (!control || !warm || !hit) throw new Error("Dry-run did not capture every variant");
	const payloads = {
		"implicit-control": payloadSummary(control),
		"explicit-warm": payloadSummary(warm),
		"explicit-hit": payloadSummary(hit),
	};

	if (payloads["implicit-control"].canonicalVisibleSha256 !== payloads["explicit-hit"].canonicalVisibleSha256) {
		throw new Error("Control and explicit hit do not have identical model-visible requests");
	}
	if (payloads["explicit-warm"].cacheKeySha256 !== payloads["explicit-hit"].cacheKeySha256) {
		throw new Error("Explicit warm and hit do not share a stable routing key");
	}
	if (payloads["explicit-warm"].fullSystemPromptSha256 === payloads["explicit-hit"].fullSystemPromptSha256) {
		throw new Error("Explicit variants do not vary the dynamic system suffix");
	}
	if (new Set(Object.values(payloads).map((summary) => summary.stableSystemPromptSha256)).size !== 1) {
		throw new Error("Stable system prefix changed across variants");
	}
	for (const name of ["explicit-warm", "explicit-hit"] as const) {
		const summary = payloads[name];
		if (summary.explicitBreakpoint !== "applied") throw new Error(`${name} has no explicit breakpoint`);
		if (summary.breakpointOffsetBytes !== summary.stableSystemPromptBytes) {
			throw new Error(`${name} breakpoint is not at the stable boundary`);
		}
	}
	if (payloads["implicit-control"].explicitBreakpoint !== "unsupported") {
		throw new Error("Implicit control unexpectedly enabled explicit caching");
	}
	if (Object.values(payloads).some((summary) => summary.cacheKeyCharacters > 64)) {
		throw new Error("A cache key exceeds 64 characters");
	}
	if (Math.min(...Object.values(payloads).map((summary) => summary.bytes)) < 16_000) {
		throw new Error("Stable prompt is too small for the experiment");
	}
	return { verdict: "proven", payloads };
}

function getText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function summarizeUsage(usage: Usage): UsageSummary {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		uncachedInputTokens: usage.input,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		promptTokens,
		cacheReadRatePercent: promptTokens === 0 ? 0 : (usage.cacheRead / promptTokens) * 100,
		outputTokens: usage.output,
		totalTokens: usage.totalTokens,
	};
}

async function completeMeasured(
	variant: Variant,
	baseModel: Model<"openai-responses">,
	stableSystemPrompt: string,
	options: Omit<OpenAIResponsesOptions, "sessionId">,
): Promise<LiveMeasurement> {
	const requestModel = explicitModel(baseModel, variant.explicit);
	const context = buildContext(stableSystemPrompt, variant.dynamicLabel);
	let prepared: PreparedPayload | undefined;
	let message: AssistantMessage | undefined;
	let ttftMs: number | undefined;
	const startedAt = Date.now();
	const stream = streamOpenAIResponses(requestModel, context, {
		...options,
		sessionId: variant.sessionId,
		onPayload: (payload) => {
			prepared = preparePayload(payload, requestModel, stableSystemPrompt, variant.explicit);
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
	if (!message || !prepared) throw new Error(`${variant.name} request ended without complete evidence`);
	const output = getText(message);
	if (output !== EXPECTED_FINAL_TEXT) {
		throw new Error(`${variant.name} returned unexpected text: ${JSON.stringify(output)}`);
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

function compare(baseline: LiveMeasurement, hit: LiveMeasurement): Comparison {
	const uncachedInputReductionTokens = baseline.usage.uncachedInputTokens - hit.usage.uncachedInputTokens;
	const ttftReductionMs = baseline.ttftMs - hit.ttftMs;
	const elapsedReductionMs = baseline.elapsedMs - hit.elapsedMs;
	return {
		cacheReadLiftTokens: hit.usage.cacheReadTokens - baseline.usage.cacheReadTokens,
		cacheWriteDeltaTokens: hit.usage.cacheWriteTokens - baseline.usage.cacheWriteTokens,
		uncachedInputReductionTokens,
		uncachedInputReductionPercent: percentage(uncachedInputReductionTokens, baseline.usage.uncachedInputTokens),
		cacheReadRateDeltaPoints: hit.usage.cacheReadRatePercent - baseline.usage.cacheReadRatePercent,
		ttftReductionMs,
		ttftReductionPercent: percentage(ttftReductionMs, baseline.ttftMs),
		elapsedReductionMs,
		elapsedReductionPercent: percentage(elapsedReductionMs, baseline.elapsedMs),
	};
}

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]");
}

function classify(measurements: LiveMeasurement[], error: string | undefined): Verdict {
	if (error) {
		return /(?:502|prompt_cache_breakpoint|prompt_cache_options)/iu.test(error)
			? "provider-rejected-explicit-breakpoint"
			: "unsupported-or-incomplete";
	}
	const warm = measurements.find((measurement) => measurement.variant === "explicit-warm");
	const hit = measurements.find((measurement) => measurement.variant === "explicit-hit");
	if (!warm || !hit) return "unsupported-or-incomplete";
	return hit.usage.cacheReadTokens > warm.usage.cacheReadTokens &&
		hit.usage.uncachedInputTokens < warm.usage.uncachedInputTokens
		? "proven-dynamic-prefix-reuse"
		: "no-observed-dynamic-prefix-reuse";
}

async function runLive(args: Args): Promise<void> {
	const runId = randomUUID();
	const dryRunProof = await proveDryRun(runId);
	const authStorage = AuthStorage.create();
	const registry = await createModelRegistry(authStorage);
	const candidate = registry.find(args.provider, args.model);
	if (!candidate) throw new Error(`Model not found: ${args.provider}/${args.model}`);
	if (candidate.api !== "openai-responses") throw new Error(`Expected openai-responses, received ${candidate.api}`);
	const resolved = await registry.getApiKeyAndHeaders(candidate as Model<Api>);
	if (!resolved.ok) throw new Error(resolved.error);
	const baseModel = (
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
	if (experimentVariants.length !== MAX_PROVIDER_REQUESTS) throw new Error("Request-limit invariant failed");
	const stableSystemPrompt = buildStableSystemPrompt(runId);
	const measurements: LiveMeasurement[] = [];
	let attemptedRequests = 0;
	let error: string | undefined;
	for (const variant of experimentVariants) {
		if (attemptedRequests >= MAX_PROVIDER_REQUESTS) break;
		attemptedRequests++;
		try {
			measurements.push(await completeMeasured(variant, baseModel, stableSystemPrompt, options));
		} catch (requestError) {
			error = sanitizeError(requestError);
			break;
		}
	}
	const control = measurements.find((measurement) => measurement.variant === "implicit-control");
	const warm = measurements.find((measurement) => measurement.variant === "explicit-warm");
	const hit = measurements.find((measurement) => measurement.variant === "explicit-hit");
	console.log(
		JSON.stringify(
			{
				mode: "live",
				provider: args.provider,
				model: args.model,
				experimentIdSha256: sha256(runId),
				requestLimit: MAX_PROVIDER_REQUESTS,
				attemptedRequests,
				dryRunProof,
				verdict: classify(measurements, error),
				warmToHit: warm && hit ? compare(warm, hit) : undefined,
				controlToHit: control && hit ? compare(control, hit) : undefined,
				measurements,
				error,
			},
			null,
			2,
		),
	);
	if (error || measurements.length !== MAX_PROVIDER_REQUESTS) process.exitCode = 1;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "dry-run") {
		console.log(JSON.stringify({ mode: "dry-run", dryRunProof: await proveDryRun("dry-run-v2") }, null, 2));
		return;
	}
	await runLive(args);
}

main().catch((error: unknown) => {
	console.error(sanitizeError(error));
	process.exitCode = 1;
});
