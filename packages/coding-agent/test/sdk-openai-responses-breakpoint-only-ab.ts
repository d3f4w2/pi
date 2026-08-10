#!/usr/bin/env node
/**
 * Bounded proof for breakpoint-only prompt caching on an OpenAI Responses endpoint.
 *
 * Dry-run mode proves the outbound payload invariants without network access.
 * Live mode sends at most three requests, with SDK retries disabled, and stops
 * immediately after the first provider error.
 */

import { createHash } from "node:crypto";
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
import { createModelRegistry } from "./model-runtime-test-utils.ts";

type Mode = "dry-run" | "live";
type VariantName = "breakpoint-warm" | "breakpoint-hit" | "implicit-control";
type Verdict =
	| "proven-breakpoint-advantage"
	| "accepted-equal-cache-read"
	| "proven-breakpoint-disadvantage"
	| "accepted-no-observed-cache-read"
	| "unsupported-or-incomplete";

interface Args {
	mode: Mode;
	provider: string;
	model: string;
}

interface Variant {
	name: VariantName;
	userSuffix: string;
	includeBreakpoint: boolean;
}

interface PayloadSummary {
	sha256: string;
	bytes: number;
	stablePrefixSha256: string;
	stablePrefixBytes: number;
	cacheKeySha256: string;
	breakpointCount: number;
	hasPromptCacheOptions: boolean;
}

interface DryRunProof {
	verdict: "proven";
	payloads: Record<VariantName, PayloadSummary>;
}

interface LiveMeasurement {
	variant: VariantName;
	elapsedMs: number;
	ttftMs: number;
	stopReason: AssistantMessage["stopReason"];
	output: string;
	usage: Usage;
	payload: PayloadSummary;
}

const DEFAULT_PROVIDER = "rayin-gpt";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_PROVIDER_REQUESTS = 3;
const EXPECTED_FINAL_TEXT = "BREAKPOINT_ONLY_OK";
const DRY_RUN_SESSION_ID = "breakpoint-only-cache-proof-dry-v1";
const VARIANTS: Variant[] = [
	{ name: "breakpoint-warm", userSuffix: "variant-a", includeBreakpoint: true },
	{ name: "breakpoint-hit", userSuffix: "variant-b", includeBreakpoint: true },
	{ name: "implicit-control", userSuffix: "variant-c", includeBreakpoint: false },
];

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
				console.log(`Usage: node test/sdk-openai-responses-breakpoint-only-ab.ts [options]

Options:
  --dry-run             Validate transformed payloads without network access (default)
  --live                Send at most three requests with retries disabled
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

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSystemPrompt(): string {
	const lines = [
		"This is a deterministic breakpoint-only prompt-cache experiment.",
		`Reply to every user request with exactly ${EXPECTED_FINAL_TEXT}.`,
		"Do not add punctuation, formatting, explanation, or tool calls.",
	];
	for (let i = 1; i <= 180; i++) {
		lines.push(
			`Stable instruction ${String(i).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron.`,
		);
	}
	return lines.join("\n");
}

function buildContext(systemPrompt: string, variant: Variant): Context {
	const messages: Message[] = [
		{
			role: "user",
			content: `Return exactly ${EXPECTED_FINAL_TEXT}. Request suffix: ${variant.userSuffix}.`,
			timestamp: 1,
		},
	];
	return { systemPrompt, messages, tools: [] };
}

function getInput(payload: Record<string, unknown>): unknown[] {
	if (!Array.isArray(payload.input)) throw new Error("Provider payload input is not an array");
	return payload.input;
}

function getSystemMessage(payload: Record<string, unknown>): Record<string, unknown> {
	const message = getInput(payload).find(
		(item) => isRecord(item) && (item.role === "system" || item.role === "developer"),
	);
	if (!isRecord(message)) throw new Error("Provider payload has no system/developer message");
	return message;
}

function extractSystemText(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) throw new Error("System message content has an unsupported shape");
	const texts = message.content.map((item) => {
		if (!isRecord(item) || item.type !== "input_text" || typeof item.text !== "string") {
			throw new Error("System message content contains a non-text block");
		}
		return item.text;
	});
	return texts.join("");
}

function transformPayload(payload: unknown, includeBreakpoint: boolean): Record<string, unknown> {
	if (!isRecord(payload)) throw new Error("Provider payload is not an object");
	const transformed = structuredClone(payload);
	delete transformed.prompt_cache_options;
	const systemMessage = getSystemMessage(transformed);
	const stableText = extractSystemText(systemMessage);
	systemMessage.content = includeBreakpoint
		? [
				{
					type: "input_text",
					text: stableText,
					prompt_cache_breakpoint: { mode: "explicit" },
				},
			]
		: stableText;
	return transformed;
}

function countBreakpoints(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countBreakpoints(item), 0);
	if (!isRecord(value)) return 0;
	let count = Object.hasOwn(value, "prompt_cache_breakpoint") ? 1 : 0;
	for (const item of Object.values(value)) count += countBreakpoints(item);
	return count;
}

function payloadSummary(payload: unknown): PayloadSummary {
	if (!isRecord(payload)) throw new Error("Provider payload is not an object");
	const serialized = JSON.stringify(payload);
	const stableText = extractSystemText(getSystemMessage(payload));
	if (typeof payload.prompt_cache_key !== "string") throw new Error("Provider payload has no prompt_cache_key");
	return {
		sha256: sha256(serialized),
		bytes: Buffer.byteLength(serialized),
		stablePrefixSha256: sha256(stableText),
		stablePrefixBytes: Buffer.byteLength(stableText),
		cacheKeySha256: sha256(payload.prompt_cache_key),
		breakpointCount: countBreakpoints(payload),
		hasPromptCacheOptions: Object.hasOwn(payload, "prompt_cache_options"),
	};
}

async function capturePayload(
	model: Model<"openai-responses">,
	context: Context,
	includeBreakpoint: boolean,
): Promise<unknown> {
	let captured: unknown;
	const stream = streamOpenAIResponses(model, context, {
		apiKey: "dry-run-key",
		cacheRetention: "short",
		maxRetries: 0,
		maxTokens: 32,
		reasoningEffort: "minimal",
		sessionId: DRY_RUN_SESSION_ID,
		onPayload: (payload) => {
			captured = transformPayload(payload, includeBreakpoint);
			throw new Error("dry-run payload captured");
		},
	});
	for await (const _event of stream) {
		// Consuming the error event completes the no-network capture.
	}
	if (captured === undefined) throw new Error("Dry-run did not capture a payload");
	return captured;
}

async function proveDryRun(): Promise<DryRunProof> {
	const model = getModel("openai", "gpt-5.6-sol");
	if (!model || model.api !== "openai-responses") throw new Error("OpenAI Responses fixture model unavailable");
	const systemPrompt = buildSystemPrompt();
	const captured = new Map<VariantName, unknown>();
	for (const variant of VARIANTS) {
		captured.set(
			variant.name,
			await capturePayload(model, buildContext(systemPrompt, variant), variant.includeBreakpoint),
		);
	}

	const warm = captured.get("breakpoint-warm");
	const hit = captured.get("breakpoint-hit");
	const control = captured.get("implicit-control");
	if (warm === undefined || hit === undefined || control === undefined) {
		throw new Error("Dry-run did not capture all three payloads");
	}
	const summaries = {
		"breakpoint-warm": payloadSummary(warm),
		"breakpoint-hit": payloadSummary(hit),
		"implicit-control": payloadSummary(control),
	};
	if (summaries["breakpoint-warm"].breakpointCount !== 1 || summaries["breakpoint-hit"].breakpointCount !== 1) {
		throw new Error("Breakpoint variants must contain exactly one breakpoint");
	}
	if (summaries["implicit-control"].breakpointCount !== 0) {
		throw new Error("Implicit control unexpectedly contains a breakpoint");
	}
	if (Object.values(summaries).some((summary) => summary.hasPromptCacheOptions)) {
		throw new Error("A transformed payload still contains prompt_cache_options");
	}
	const stableHashes = new Set(Object.values(summaries).map((summary) => summary.stablePrefixSha256));
	const cacheKeyHashes = new Set(Object.values(summaries).map((summary) => summary.cacheKeySha256));
	if (stableHashes.size !== 1) throw new Error("Stable system prefix differs across variants");
	if (cacheKeyHashes.size !== 1) throw new Error("Prompt cache key differs across variants");
	if (new Set(Object.values(summaries).map((summary) => summary.sha256)).size !== VARIANTS.length) {
		throw new Error("Full provider payloads must differ across the three variants");
	}
	if (summaries["breakpoint-warm"].stablePrefixBytes < 4_096) {
		throw new Error("Stable prefix is too small for a meaningful cache experiment");
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

async function completeMeasured(
	variant: Variant,
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
			const transformed = transformPayload(requestPayload, variant.includeBreakpoint);
			payload = structuredClone(transformed);
			return transformed;
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
	if (payload === undefined) throw new Error(`${variant.name} request did not expose its payload`);
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
		usage: message.usage,
		payload: payloadSummary(payload),
	};
}

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]");
}

function classify(breakpointHit: LiveMeasurement | undefined, implicitControl: LiveMeasurement | undefined): Verdict {
	if (!breakpointHit || !implicitControl) return "unsupported-or-incomplete";
	if (breakpointHit.usage.cacheRead > implicitControl.usage.cacheRead) return "proven-breakpoint-advantage";
	if (breakpointHit.usage.cacheRead < implicitControl.usage.cacheRead) return "proven-breakpoint-disadvantage";
	if (breakpointHit.usage.cacheRead > 0) return "accepted-equal-cache-read";
	return "accepted-no-observed-cache-read";
}

async function runLive(args: Args, dryRunProof: DryRunProof): Promise<void> {
	if (VARIANTS.length !== MAX_PROVIDER_REQUESTS) throw new Error("Live experiment request limit invariant failed");
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
		sessionId: `breakpoint-only-cache-proof-live-${Date.now()}`,
		timeoutMs: 60_000,
	};

	const systemPrompt = buildSystemPrompt();
	const measurements: LiveMeasurement[] = [];
	let attemptedRequests = 0;
	let error: string | undefined;
	for (const variant of VARIANTS) {
		if (attemptedRequests >= MAX_PROVIDER_REQUESTS) {
			error = "Provider request limit reached";
			break;
		}
		attemptedRequests++;
		try {
			measurements.push(await completeMeasured(variant, model, buildContext(systemPrompt, variant), options));
		} catch (requestError) {
			error = sanitizeError(requestError);
			break;
		}
	}

	const breakpointHit = measurements.find((measurement) => measurement.variant === "breakpoint-hit");
	const implicitControl = measurements.find((measurement) => measurement.variant === "implicit-control");
	const verdict = classify(breakpointHit, implicitControl);
	const comparison =
		breakpointHit && implicitControl
			? {
					cacheReadDelta: breakpointHit.usage.cacheRead - implicitControl.usage.cacheRead,
					uncachedInputDelta: breakpointHit.usage.input - implicitControl.usage.input,
					ttftDeltaMs: breakpointHit.ttftMs - implicitControl.ttftMs,
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
				dryRunProof,
				verdict,
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
	const dryRunProof = await proveDryRun();
	if (args.mode === "dry-run") {
		console.log(JSON.stringify({ mode: "dry-run", dryRunProof }, null, 2));
		return;
	}
	await runLive(args, dryRunProof);
}

main().catch((error: unknown) => {
	console.error(sanitizeError(error));
	process.exitCode = 1;
});
