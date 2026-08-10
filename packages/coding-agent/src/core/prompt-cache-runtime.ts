import { createHash } from "node:crypto";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type PromptCacheDiagnosticChange,
	PromptCacheDiagnosticTracker,
	type PromptCacheOptimizationDiagnostic,
	type PromptCacheRequestDiagnostic,
} from "./prompt-cache-optimizer.ts";

export interface PromptCacheRuntimeSnapshot {
	requests: number;
	responses: number;
	promptTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	actualCacheReadRate: number;
	firstResponseCacheReadRate: number;
	subsequentResponseCacheReadRate: number;
	lastResponseCacheReadRate: number;
	exactPrefixBytes: number;
	comparableInputBytes: number;
	exactPrefixByteRate: number;
	estimatedSavingsUsd: number;
	changeCounts: Partial<Record<PromptCacheDiagnosticChange, number>>;
	breakpointDecisions: Record<string, number>;
	compactionDeferrals: number;
	continuationAttempts: number;
	continuationSuccesses: number;
	continuationFallbacks: number;
	providerRetryAttempts: number;
	providerRetryRecoveries: number;
	providerRetryFailures: number;
	lastResponseAt?: number;
}

interface SerializedInput {
	items: string[];
	bytes: number;
	sha256: string;
}

function serializeInput(payload: unknown): SerializedInput {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return { items: [], bytes: 0, sha256: createHash("sha256").update("").digest("hex") };
	}
	const input = (payload as Record<string, unknown>).input;
	if (!Array.isArray(input)) {
		return { items: [], bytes: 0, sha256: createHash("sha256").update("").digest("hex") };
	}
	const items = input.map((item) => JSON.stringify(item) ?? "undefined");
	const serialized = items.join(",");
	return {
		items,
		bytes: Buffer.byteLength(serialized),
		sha256: createHash("sha256").update(serialized).digest("hex"),
	};
}

function commonPrefixBytes(previous: string[], current: string[]): number {
	let bytes = 0;
	const length = Math.min(previous.length, current.length);
	for (let index = 0; index < length; index++) {
		const left = previous[index];
		const right = current[index];
		if (left === right) {
			bytes += Buffer.byteLength(left);
			continue;
		}
		let character = 0;
		const characterLength = Math.min(left.length, right.length);
		while (character < characterLength && left[character] === right[character]) character++;
		bytes += Buffer.byteLength(left.slice(0, character));
		break;
	}
	return bytes;
}

/** Session-local request/usage recorder. It stores hashes and counters, never prompt text. */
export class PromptCacheRuntime {
	private readonly getModel: (provider: string, modelId: string) => Model<Api> | undefined;
	private readonly tracker = new PromptCacheDiagnosticTracker();
	private previousInput: SerializedInput | undefined;
	private requests = 0;
	private responses = 0;
	private promptTokens = 0;
	private cacheReadTokens = 0;
	private cacheWriteTokens = 0;
	private successfulPromptResponses = 0;
	private firstResponsePromptTokens = 0;
	private firstResponseCacheReadTokens = 0;
	private subsequentResponsePromptTokens = 0;
	private subsequentResponseCacheReadTokens = 0;
	private lastResponseCacheReadRate = 0;
	private exactPrefixBytes = 0;
	private comparableInputBytes = 0;
	private estimatedSavingsUsd = 0;
	private readonly changeCounts: Partial<Record<PromptCacheDiagnosticChange, number>> = {};
	private readonly breakpointDecisions: Record<string, number> = {};
	private compactionDeferrals = 0;
	private continuationAttempts = 0;
	private continuationSuccesses = 0;
	private continuationFallbacks = 0;
	private providerRetryAttempts = 0;
	private providerRetryRecoveries = 0;
	private providerRetryFailures = 0;
	private lastResponseAt: number | undefined;

	constructor(getModel: (provider: string, modelId: string) => Model<Api> | undefined) {
		this.getModel = getModel;
	}

	recordRequest(
		diagnostic: PromptCacheOptimizationDiagnostic,
		payload: unknown,
		timestamp = Date.now(),
	): PromptCacheRequestDiagnostic {
		const request = this.tracker.record(diagnostic, timestamp);
		const input = serializeInput(payload);
		if (this.previousInput) {
			this.exactPrefixBytes += commonPrefixBytes(this.previousInput.items, input.items);
			this.comparableInputBytes += input.bytes;
		}
		this.previousInput = input;
		this.requests++;
		for (const change of request.changes) this.changeCounts[change] = (this.changeCounts[change] ?? 0) + 1;
		const decision = diagnostic.breakpointDecision ?? "not-applicable";
		this.breakpointDecisions[decision] = (this.breakpointDecisions[decision] ?? 0) + 1;
		return request;
	}

	recordResponse(message: AssistantMessage): void {
		const usage = message.usage;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		this.responses++;
		this.promptTokens += promptTokens;
		this.cacheReadTokens += usage.cacheRead;
		this.cacheWriteTokens += usage.cacheWrite;
		if (promptTokens > 0) {
			if (this.successfulPromptResponses === 0) {
				this.firstResponsePromptTokens += promptTokens;
				this.firstResponseCacheReadTokens += usage.cacheRead;
			} else {
				this.subsequentResponsePromptTokens += promptTokens;
				this.subsequentResponseCacheReadTokens += usage.cacheRead;
			}
			this.successfulPromptResponses++;
		}
		this.lastResponseCacheReadRate = promptTokens > 0 ? usage.cacheRead / promptTokens : 0;
		this.lastResponseAt = message.timestamp;
		for (const diagnostic of message.diagnostics ?? []) {
			if (diagnostic.type === "openai_stateful_continuation") {
				this.continuationAttempts++;
				if (diagnostic.details?.status === "success") this.continuationSuccesses++;
				if (diagnostic.details?.status === "fallback") this.continuationFallbacks++;
			}
			if (diagnostic.type === "provider_request_retry") {
				const attempts = diagnostic.details?.attempts;
				if (typeof attempts === "number" && Number.isInteger(attempts) && attempts > 0) {
					this.providerRetryAttempts += attempts;
				}
				if (diagnostic.details?.status === "success") this.providerRetryRecoveries++;
				if (diagnostic.details?.status === "failed") this.providerRetryFailures++;
			}
		}

		const model = this.getModel(message.provider, message.model);
		if (model && model.cost.input > 0) {
			const noCacheCost = (promptTokens * model.cost.input) / 1_000_000;
			const actualPromptCost = usage.cost.input + usage.cost.cacheRead + usage.cost.cacheWrite;
			this.estimatedSavingsUsd += Math.max(0, noCacheCost - actualPromptCost);
		}
	}

	recordCompactionDeferral(): void {
		this.compactionDeferrals++;
	}

	snapshot(): PromptCacheRuntimeSnapshot {
		return {
			requests: this.requests,
			responses: this.responses,
			promptTokens: this.promptTokens,
			cacheReadTokens: this.cacheReadTokens,
			cacheWriteTokens: this.cacheWriteTokens,
			actualCacheReadRate: this.promptTokens > 0 ? this.cacheReadTokens / this.promptTokens : 0,
			firstResponseCacheReadRate:
				this.firstResponsePromptTokens > 0 ? this.firstResponseCacheReadTokens / this.firstResponsePromptTokens : 0,
			subsequentResponseCacheReadRate:
				this.subsequentResponsePromptTokens > 0
					? this.subsequentResponseCacheReadTokens / this.subsequentResponsePromptTokens
					: 0,
			lastResponseCacheReadRate: this.lastResponseCacheReadRate,
			exactPrefixBytes: this.exactPrefixBytes,
			comparableInputBytes: this.comparableInputBytes,
			exactPrefixByteRate:
				this.comparableInputBytes > 0 ? Math.min(1, this.exactPrefixBytes / this.comparableInputBytes) : 0,
			estimatedSavingsUsd: this.estimatedSavingsUsd,
			changeCounts: { ...this.changeCounts },
			breakpointDecisions: { ...this.breakpointDecisions },
			compactionDeferrals: this.compactionDeferrals,
			continuationAttempts: this.continuationAttempts,
			continuationSuccesses: this.continuationSuccesses,
			continuationFallbacks: this.continuationFallbacks,
			providerRetryAttempts: this.providerRetryAttempts,
			providerRetryRecoveries: this.providerRetryRecoveries,
			providerRetryFailures: this.providerRetryFailures,
			lastResponseAt: this.lastResponseAt,
		};
	}
}
