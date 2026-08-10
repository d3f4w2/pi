import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

export type PromptCacheOptimizationReason =
	| "optimized"
	| "unsupported-api"
	| "cache-disabled"
	| "invalid-payload"
	| "missing-stable-prefix";

export interface PromptCacheOptimizationDiagnostic {
	reason: PromptCacheOptimizationReason;
	stableShapeSha256?: string;
	stableShapeBytes?: number;
}

export interface PromptCacheOptimization {
	payload: unknown;
	diagnostic: PromptCacheOptimizationDiagnostic;
}

const SHARED_PREFIX_KEY_PREFIX = "pi-prefix-v1-";
const SHARED_PREFIX_KEY_DIGEST_CHARACTERS = 48;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leadingSystemMessages(input: unknown[]): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];
	for (const item of input) {
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break;
		messages.push(item);
	}
	return messages;
}

/**
 * Replace a session-scoped OpenAI Responses cache key with a project-scoped
 * stable-prefix fingerprint. The provider still validates the exact prefix;
 * this key only improves cache routing for matching request shapes.
 */
export function optimizeOpenAIResponsesPromptCache(
	payload: unknown,
	model: Model<Api>,
	projectScope: string,
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
		const tools = payload.tools ?? [];
		const hasStablePrefix =
			prefixMessages.length > 0 ||
			(payload.instructions !== undefined && payload.instructions !== "") ||
			tools.length > 0 ||
			payload.text !== undefined;
		if (!hasStablePrefix) {
			return { payload, diagnostic: { reason: "missing-stable-prefix" } };
		}

		const stableShape = JSON.stringify({
			version: 1,
			projectScope,
			provider: model.provider,
			api: model.api,
			modelId: model.id,
			requestModel: payload.model,
			instructions: payload.instructions,
			prefixMessages,
			tools,
			text: payload.text,
		});
		const stableShapeSha256 = createHash("sha256").update(stableShape).digest("hex");
		const promptCacheKey = `${SHARED_PREFIX_KEY_PREFIX}${stableShapeSha256.slice(0, SHARED_PREFIX_KEY_DIGEST_CHARACTERS)}`;

		return {
			payload: { ...payload, prompt_cache_key: promptCacheKey },
			diagnostic: {
				reason: "optimized",
				stableShapeSha256,
				stableShapeBytes: Buffer.byteLength(stableShape),
			},
		};
	} catch {
		return { payload, diagnostic: { reason: "invalid-payload" } };
	}
}
