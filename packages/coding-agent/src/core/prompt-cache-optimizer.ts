import { createHash } from "node:crypto";
import type { Api, Model, OpenAIResponsesCompat } from "@earendil-works/pi-ai/compat";

export type PromptCacheOptimizationReason =
	| "optimized"
	| "unsupported-api"
	| "cache-disabled"
	| "invalid-payload"
	| "missing-stable-prefix";

export type PromptCacheBreakpointStatus = "applied" | "unsupported" | "prefix-mismatch" | "not-applicable";

export type PromptCacheDiagnosticChange =
	| "project-scope"
	| "model"
	| "stable-system-prefix"
	| "dynamic-system-suffix"
	| "tool-schema"
	| "tool-order"
	| "output-shape";

export interface PromptCacheOptimizationDiagnostic {
	reason: PromptCacheOptimizationReason;
	promptCacheKey?: string;
	stableShapeSha256?: string;
	stableShapeBytes?: number;
	projectScopeSha256?: string;
	modelSha256?: string;
	stableSystemPromptSha256?: string;
	fullSystemPromptSha256?: string;
	stableSystemPromptBytes?: number;
	dynamicSystemPromptBytes?: number;
	toolOrderSha256?: string;
	toolSetSha256?: string;
	outputShapeSha256?: string;
	explicitBreakpoint?: PromptCacheBreakpointStatus;
}

export interface PromptCacheRequestDiagnostic extends PromptCacheOptimizationDiagnostic {
	keyChanged: boolean;
	changes: PromptCacheDiagnosticChange[];
	requestsPerMinute: number;
	hotKey: boolean;
}

export interface PromptCacheOptimization {
	payload: unknown;
	diagnostic: PromptCacheOptimizationDiagnostic;
}

export interface PromptCacheOptimizationOptions {
	/** Exact base system prompt. The full effective prompt must start with this value. */
	stableSystemPrompt?: string;
}

const SHARED_PREFIX_KEY_PREFIX = "pi-prefix-v2-";
const SHARED_PREFIX_KEY_DIGEST_CHARACTERS = 48;
const HOT_KEY_REQUESTS_PER_MINUTE = 15;
const RATE_WINDOW_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
	return hash(JSON.stringify(value) ?? "undefined");
}

function leadingSystemMessages(input: unknown[]): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];
	for (const item of input) {
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break;
		messages.push(item);
	}
	return messages;
}

interface SystemMessageText {
	text: string;
	rewritable: boolean;
}

function systemMessageText(message: Record<string, unknown> | undefined): SystemMessageText | undefined {
	if (!message) return undefined;
	if (typeof message.content === "string") return { text: message.content, rewritable: true };
	if (!Array.isArray(message.content)) return undefined;

	let text = "";
	for (const item of message.content) {
		if (!isRecord(item) || item.type !== "input_text" || typeof item.text !== "string") return undefined;
		const extraKeys = Object.keys(item).filter(
			(key) => key !== "type" && key !== "text" && key !== "prompt_cache_breakpoint",
		);
		if (extraKeys.length > 0) return { text: "", rewritable: false };
		text += item.text;
	}
	return { text, rewritable: true };
}

function supportsExplicitBreakpoint(model: Model<Api>): boolean {
	const compat = model.compat as OpenAIResponsesCompat | undefined;
	return compat?.supportsExplicitPromptCacheMode === true && compat.supportsPromptCacheBreakpoints === true;
}

function replaceSystemPromptWithBreakpoint(
	payload: Record<string, unknown>,
	input: unknown[],
	stableSystemPrompt: string,
	fullSystemPrompt: SystemMessageText,
): Record<string, unknown> {
	const firstMessage = input[0];
	if (!isRecord(firstMessage)) return payload;

	const suffix = fullSystemPrompt.text.slice(stableSystemPrompt.length);
	const content: Array<Record<string, unknown>> = [
		{
			type: "input_text",
			text: stableSystemPrompt,
			prompt_cache_breakpoint: { mode: "explicit" },
		},
	];
	if (suffix.length > 0) content.push({ type: "input_text", text: suffix });

	const nextInput = [...input];
	nextInput[0] = { ...firstMessage, content };
	return {
		...payload,
		input: nextInput,
		prompt_cache_options: { mode: "explicit", ttl: "30m" },
		prompt_cache_retention: undefined,
	};
}

function canonicalToolSet(tools: unknown[]): string[] {
	return tools.map((tool) => JSON.stringify(tool)).sort((left, right) => left.localeCompare(right));
}

/**
 * Replace a session-scoped OpenAI Responses cache key with a project-scoped
 * stable-prefix fingerprint. When the provider explicitly supports cache
 * breakpoints, split the existing system content at the exact stable boundary
 * without changing the concatenated model-visible text.
 */
export function optimizeOpenAIResponsesPromptCache(
	payload: unknown,
	model: Model<Api>,
	projectScope: string,
	options: PromptCacheOptimizationOptions = {},
): PromptCacheOptimization {
	if (model.api !== "openai-responses") {
		return { payload, diagnostic: { reason: "unsupported-api" } };
	}

	try {
		if (!isRecord(payload) || !Array.isArray(payload.input)) {
			return { payload, diagnostic: { reason: "invalid-payload" } };
		}
		if (typeof payload.prompt_cache_key !== "string" || payload.prompt_cache_key.length === 0) {
			return { payload, diagnostic: { reason: "cache-disabled" } };
		}
		if (payload.tools !== undefined && !Array.isArray(payload.tools)) {
			return { payload, diagnostic: { reason: "invalid-payload" } };
		}

		const prefixMessages = leadingSystemMessages(payload.input);
		const firstSystemMessage = systemMessageText(prefixMessages[0]);
		const requestedStableSystemPrompt = options.stableSystemPrompt;
		const stablePrefixMatches =
			requestedStableSystemPrompt !== undefined &&
			requestedStableSystemPrompt.length > 0 &&
			firstSystemMessage?.text.startsWith(requestedStableSystemPrompt) === true;
		const stableSystemPrompt = stablePrefixMatches ? requestedStableSystemPrompt : firstSystemMessage?.text;
		const tools = payload.tools ?? [];
		const hasStablePrefix =
			(stableSystemPrompt !== undefined && stableSystemPrompt.length > 0) ||
			(payload.instructions !== undefined && payload.instructions !== "") ||
			tools.length > 0 ||
			payload.text !== undefined;
		if (!hasStablePrefix) {
			return { payload, diagnostic: { reason: "missing-stable-prefix" } };
		}

		const stablePrefixMessages = prefixMessages.map((message, index) =>
			index === 0 && stableSystemPrompt !== undefined
				? { role: message.role, content: stableSystemPrompt }
				: message,
		);
		const modelShape = {
			provider: model.provider,
			api: model.api,
			modelId: model.id,
			requestModel: payload.model,
		};
		const outputShape = payload.text;
		const stableShape = JSON.stringify({
			version: 2,
			projectScope,
			...modelShape,
			instructions: payload.instructions,
			prefixMessages: stablePrefixMessages,
			tools,
			text: outputShape,
		});
		const stableShapeSha256 = hash(stableShape);
		const promptCacheKey = `${SHARED_PREFIX_KEY_PREFIX}${stableShapeSha256.slice(0, SHARED_PREFIX_KEY_DIGEST_CHARACTERS)}`;

		let explicitBreakpoint: PromptCacheBreakpointStatus = "not-applicable";
		let transformedPayload: Record<string, unknown> = { ...payload, prompt_cache_key: promptCacheKey };
		if (supportsExplicitBreakpoint(model)) {
			if (
				requestedStableSystemPrompt !== undefined &&
				stablePrefixMatches &&
				firstSystemMessage?.rewritable === true
			) {
				transformedPayload = replaceSystemPromptWithBreakpoint(
					transformedPayload,
					payload.input,
					requestedStableSystemPrompt,
					firstSystemMessage,
				);
				explicitBreakpoint = "applied";
			} else if (requestedStableSystemPrompt !== undefined) {
				explicitBreakpoint = "prefix-mismatch";
			}
		} else if (requestedStableSystemPrompt !== undefined) {
			explicitBreakpoint = "unsupported";
		}

		const fullSystemPrompt = firstSystemMessage?.text;
		return {
			payload: transformedPayload,
			diagnostic: {
				reason: "optimized",
				promptCacheKey,
				stableShapeSha256,
				stableShapeBytes: Buffer.byteLength(stableShape),
				projectScopeSha256: hash(projectScope),
				modelSha256: hashJson(modelShape),
				stableSystemPromptSha256: stableSystemPrompt === undefined ? undefined : hash(stableSystemPrompt),
				fullSystemPromptSha256: fullSystemPrompt === undefined ? undefined : hash(fullSystemPrompt),
				stableSystemPromptBytes:
					stableSystemPrompt === undefined ? undefined : Buffer.byteLength(stableSystemPrompt),
				dynamicSystemPromptBytes:
					stablePrefixMatches && fullSystemPrompt !== undefined && requestedStableSystemPrompt !== undefined
						? Buffer.byteLength(fullSystemPrompt.slice(requestedStableSystemPrompt.length))
						: 0,
				toolOrderSha256: hashJson(tools),
				toolSetSha256: hashJson(canonicalToolSet(tools)),
				outputShapeSha256: hashJson(outputShape),
				explicitBreakpoint,
			},
		};
	} catch {
		return { payload, diagnostic: { reason: "invalid-payload" } };
	}
}

/** Session-local, privacy-safe cache-shape and request-rate diagnostics. */
export class PromptCacheDiagnosticTracker {
	private previous: PromptCacheOptimizationDiagnostic | undefined;
	private readonly requestsByKey = new Map<string, number[]>();

	record(diagnostic: PromptCacheOptimizationDiagnostic, timestamp = Date.now()): PromptCacheRequestDiagnostic {
		const changes: PromptCacheDiagnosticChange[] = [];
		const previous = this.previous;
		if (previous) {
			if (previous.projectScopeSha256 !== diagnostic.projectScopeSha256) changes.push("project-scope");
			if (previous.modelSha256 !== diagnostic.modelSha256) changes.push("model");
			if (previous.stableSystemPromptSha256 !== diagnostic.stableSystemPromptSha256) {
				changes.push("stable-system-prefix");
			} else if (previous.fullSystemPromptSha256 !== diagnostic.fullSystemPromptSha256) {
				changes.push("dynamic-system-suffix");
			}
			if (previous.toolSetSha256 !== diagnostic.toolSetSha256) {
				changes.push("tool-schema");
			} else if (previous.toolOrderSha256 !== diagnostic.toolOrderSha256) {
				changes.push("tool-order");
			}
			if (previous.outputShapeSha256 !== diagnostic.outputShapeSha256) changes.push("output-shape");
		}

		const key = diagnostic.promptCacheKey;
		let requestsPerMinute = 0;
		if (key !== undefined) {
			const cutoff = timestamp - RATE_WINDOW_MS;
			const recent = (this.requestsByKey.get(key) ?? []).filter((entry) => entry > cutoff);
			recent.push(timestamp);
			this.requestsByKey.set(key, recent);
			requestsPerMinute = recent.length;
		}

		this.previous = diagnostic;
		return {
			...diagnostic,
			keyChanged: previous?.promptCacheKey !== undefined && previous.promptCacheKey !== key,
			changes,
			requestsPerMinute,
			hotKey: requestsPerMinute > HOT_KEY_REQUESTS_PER_MINUTE,
		};
	}
}
