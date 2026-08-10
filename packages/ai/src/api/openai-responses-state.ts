import type { ResponseCreateParamsStreaming, ResponseInput } from "openai/resources/responses/responses.js";

const CONTINUATION_FAILURE_LIMIT = 3;
const DEFAULT_MAX_SESSIONS = 128;

interface StatefulResponseEntry {
	responseId: string;
	coveredInput: string[];
	shape: string;
	continuationFailures: number;
}

export interface PreparedOpenAIResponse {
	key?: string;
	params: ResponseCreateParamsStreaming;
	fullParams: ResponseCreateParamsStreaming;
	fullInput: ResponseInput;
	shape: string;
	chained: boolean;
}

function asInput(value: ResponseCreateParamsStreaming["input"]): ResponseInput | undefined {
	return Array.isArray(value) ? value : undefined;
}

function stripPromptCacheBreakpoints(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripPromptCacheBreakpoints);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "prompt_cache_breakpoint")
			.map(([key, item]) => [key, stripPromptCacheBreakpoints(item)]),
	);
}

function serializeItems(input: ResponseInput): string[] {
	return input.map((item) => JSON.stringify(stripPromptCacheBreakpoints(item)));
}

function exactPrefixLength(prefix: string[], input: string[]): number | undefined {
	if (prefix.length >= input.length) return undefined;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index] !== input[index]) return undefined;
	}
	return prefix.length;
}

function requestShape(params: ResponseCreateParamsStreaming): string {
	const shape = { ...params } as Record<string, unknown>;
	delete shape.input;
	delete shape.previous_response_id;
	delete shape.stream;
	return JSON.stringify(shape);
}

function withoutPreviousResponseId(params: ResponseCreateParamsStreaming): ResponseCreateParamsStreaming {
	const fullParams = { ...params };
	delete fullParams.previous_response_id;
	return fullParams;
}

/** Exact-prefix state for opted-in official OpenAI Responses sessions. */
export class OpenAIResponsesState {
	private readonly entries = new Map<string, StatefulResponseEntry>();
	private readonly disabledKeys = new Set<string>();
	private readonly maxSessions: number;

	constructor(maxSessions = DEFAULT_MAX_SESSIONS) {
		this.maxSessions = maxSessions;
	}

	get size(): number {
		return this.entries.size;
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	prepare(key: string | undefined, params: ResponseCreateParamsStreaming): PreparedOpenAIResponse {
		const fullParams = withoutPreviousResponseId(params);
		if (key && this.disabledKeys.has(key)) fullParams.store = false;
		const fullInput = asInput(fullParams.input) ?? [];
		const shape = requestShape(fullParams);
		const base: PreparedOpenAIResponse = {
			key,
			params: fullParams,
			fullParams,
			fullInput,
			shape,
			chained: false,
		};
		if (!key || fullParams.store !== true || fullInput.length === 0) return base;

		const entry = this.entries.get(key);
		if (!entry || entry.continuationFailures >= CONTINUATION_FAILURE_LIMIT || entry.shape !== shape) return base;
		const serializedInput = serializeItems(fullInput);
		const prefixLength = exactPrefixLength(entry.coveredInput, serializedInput);
		if (prefixLength === undefined) return base;
		return {
			...base,
			params: {
				...fullParams,
				input: fullInput.slice(prefixLength),
				previous_response_id: entry.responseId,
			},
			chained: true,
		};
	}

	commit(
		prepared: PreparedOpenAIResponse,
		responseId: string | undefined,
		responseOutput: ResponseInput,
		preserveContinuationFailures = false,
	): void {
		if (!prepared.key || !responseId || prepared.fullParams.store !== true) return;
		const previousFailures = this.entries.get(prepared.key)?.continuationFailures ?? 0;
		this.entries.delete(prepared.key);
		this.entries.set(prepared.key, {
			responseId,
			coveredInput: serializeItems([...prepared.fullInput, ...responseOutput]),
			shape: prepared.shape,
			continuationFailures: preserveContinuationFailures ? previousFailures : 0,
		});
		while (this.entries.size > this.maxSessions) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	recordContinuationFailure(prepared: PreparedOpenAIResponse): void {
		if (!prepared.key || !prepared.chained) return;
		const entry = this.entries.get(prepared.key);
		if (!entry) return;
		entry.continuationFailures = Math.min(CONTINUATION_FAILURE_LIMIT, entry.continuationFailures + 1);
	}

	disable(key: string | undefined): void {
		if (!key) return;
		this.entries.delete(key);
		this.disabledKeys.delete(key);
		this.disabledKeys.add(key);
		while (this.disabledKeys.size > this.maxSessions) {
			const oldest = this.disabledKeys.values().next().value;
			if (oldest === undefined) break;
			this.disabledKeys.delete(oldest);
		}
	}
}

export function isOfficialOpenAIResponsesModel(model: { provider: string; baseUrl: string }): boolean {
	if (model.provider !== "openai") return false;
	try {
		return new URL(model.baseUrl).hostname.toLowerCase() === "api.openai.com";
	} catch {
		return false;
	}
}

/** Only retry a full payload for errors that identify the response handle or state. */
export function isStatefulContinuationSetupError(error: unknown): boolean {
	const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
	const status = typeof record?.status === "number" ? record.status : undefined;
	const message = error instanceof Error ? error.message : String(error);
	return (
		(status === 400 || status === 404) &&
		/(previous_response_id|previous response|response.+(?:not found|expired|store))/i.test(message)
	);
}

/** Detect official policy/ZDR rejections of provider-side response storage. */
export function isStatefulStorageSetupError(error: unknown): boolean {
	const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
	const status = typeof record?.status === "number" ? record.status : undefined;
	const message = error instanceof Error ? error.message : String(error);
	return status === 400 && /(?:\bstore\b|zero data retention|\bzdr\b|data retention)/i.test(message);
}
