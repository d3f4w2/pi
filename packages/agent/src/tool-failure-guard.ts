import type { AgentToolCall, AgentToolResult } from "./types.ts";

interface FailureRecord {
	blockedAttempts: number;
	count: number;
	signature: string;
}

export interface RepeatedToolFailureDecision {
	message: string;
	terminate: boolean;
}

const MAX_ERROR_SIGNATURE_CHARACTERS = 600;
const MAX_ERROR_SOURCE_CHARACTERS = 2_400;
const MAX_FINGERPRINT_CHARACTERS = 16_000;
const MAX_REPEAT_LIMIT = 100;

interface SerializationBudget {
	remaining: number;
}

function consumeToken(token: string, budget: SerializationBudget): string | undefined {
	if (token.length > budget.remaining) return undefined;
	budget.remaining -= token.length;
	return token;
}

function canonicalJson(value: unknown, ancestors: Set<object>, budget: SerializationBudget): string | undefined {
	if (value === null || typeof value === "boolean") return consumeToken(JSON.stringify(value), budget);
	if (typeof value === "string") {
		if (value.length + 2 > budget.remaining) return undefined;
		return consumeToken(JSON.stringify(value), budget);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? consumeToken(JSON.stringify(value), budget) : undefined;
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) return undefined;
		ancestors.add(value);
		const values: string[] = [consumeToken("[", budget) ?? ""];
		if (values[0] === "") {
			ancestors.delete(value);
			return undefined;
		}
		for (const [index, item] of value.entries()) {
			if (index > 0 && consumeToken(",", budget) === undefined) {
				ancestors.delete(value);
				return undefined;
			}
			if (index > 0) values.push(",");
			const serialized = canonicalJson(item, ancestors, budget);
			if (serialized === undefined) {
				ancestors.delete(value);
				return undefined;
			}
			values.push(serialized);
		}
		if (consumeToken("]", budget) === undefined) {
			ancestors.delete(value);
			return undefined;
		}
		values.push("]");
		ancestors.delete(value);
		return values.join("");
	}
	if (typeof value !== "object") return undefined;
	if (ancestors.has(value)) return undefined;

	ancestors.add(value);
	const record = value as Record<string, unknown>;
	const fields: string[] = [consumeToken("{", budget) ?? ""];
	if (fields[0] === "") {
		ancestors.delete(value);
		return undefined;
	}
	for (const [index, key] of Object.keys(record).sort().entries()) {
		if (index > 0 && consumeToken(",", budget) === undefined) {
			ancestors.delete(value);
			return undefined;
		}
		if (index > 0) fields.push(",");
		if (key.length + 2 > budget.remaining) {
			ancestors.delete(value);
			return undefined;
		}
		const serializedKey = consumeToken(JSON.stringify(key), budget);
		const separator = consumeToken(":", budget);
		const serialized = canonicalJson(record[key], ancestors, budget);
		if (serializedKey === undefined || separator === undefined || serialized === undefined) {
			ancestors.delete(value);
			return undefined;
		}
		fields.push(serializedKey, separator, serialized);
	}
	if (consumeToken("}", budget) === undefined) {
		ancestors.delete(value);
		return undefined;
	}
	fields.push("}");
	ancestors.delete(value);
	return fields.join("");
}

function callFingerprint(toolCall: AgentToolCall): string | undefined {
	try {
		const argumentsJson = canonicalJson(toolCall.arguments, new Set(), {
			remaining: MAX_FINGERPRINT_CHARACTERS,
		});
		return argumentsJson === undefined ? undefined : `${toolCall.name.toLowerCase()}:${argumentsJson}`;
	} catch {
		return undefined;
	}
}

function errorSignature(result: AgentToolResult<unknown>): string | undefined {
	let source = "";
	for (const part of result.content) {
		if (part.type !== "text" || source.length >= MAX_ERROR_SOURCE_CHARACTERS) continue;
		const separator = source.length === 0 ? "" : "\n";
		const remaining = MAX_ERROR_SOURCE_CHARACTERS - source.length - separator.length;
		if (remaining <= 0) break;
		source += `${separator}${part.text.slice(0, remaining)}`;
	}
	const text = source.replace(/\s+/g, " ").trim();
	if (!text || /\b(?:aborted?|cancelled|canceled)\b/i.test(text)) return undefined;
	return text.slice(0, MAX_ERROR_SIGNATURE_CHARACTERS);
}

export class RepeatedToolFailureGuard {
	private readonly failures = new Map<string, FailureRecord>();
	private readonly limit: number;

	constructor(limit: number | undefined) {
		this.limit = Number.isFinite(limit) ? Math.min(MAX_REPEAT_LIMIT, Math.max(0, Math.floor(limit ?? 0))) : 0;
	}

	reset(): void {
		this.failures.clear();
	}

	getBlockDecision(toolCall: AgentToolCall): RepeatedToolFailureDecision | undefined {
		if (this.limit === 0) return undefined;
		const fingerprint = callFingerprint(toolCall);
		if (!fingerprint) return undefined;
		const failure = this.failures.get(fingerprint);
		if (!failure || failure.count < this.limit) return undefined;
		failure.blockedAttempts++;
		const terminate = failure.blockedAttempts > 1;
		const consequence = terminate
			? "The current agent run is stopping because the previous recovery instruction was ignored."
			: "Another unchanged attempt will stop the current agent run.";
		return {
			message: `Repeated tool call blocked: this exact ${toolCall.name} call already failed ${failure.count} times with the same error. Do not repeat it unchanged. Change the arguments, use another tool, or explain the blocker. ${consequence} Last error: ${failure.signature}`,
			terminate,
		};
	}

	record(toolCall: AgentToolCall, result: AgentToolResult<unknown>, isError: boolean): void {
		if (this.limit === 0) return;
		const fingerprint = callFingerprint(toolCall);
		if (!fingerprint) return;
		if (!isError) {
			this.failures.clear();
			return;
		}

		const signature = errorSignature(result);
		if (!signature) return;
		const previous = this.failures.get(fingerprint);
		this.failures.set(fingerprint, {
			blockedAttempts: previous?.signature === signature ? previous.blockedAttempts : 0,
			count: previous?.signature === signature ? previous.count + 1 : 1,
			signature,
		});
	}
}
