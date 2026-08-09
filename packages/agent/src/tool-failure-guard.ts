import type { AgentToolCall, AgentToolResult, ToolCircuitStatus, ToolFailureGuardSnapshot } from "./types.ts";

interface FailureRecord {
	blockedAttempts: number;
	count: number;
	signature: string;
}

interface ToolCircuitRecord {
	blockedAttempts: number;
	consecutiveFailures: number;
	halfOpen: boolean;
	lastError: string;
	openedAt?: number;
}

export interface ToolFailureGuardOptions {
	repeatLimit?: number;
	consecutiveLimit?: number;
	cooldownMs?: number;
	timeoutMs?: number;
	now?: () => number;
	onChange?: (snapshot: ToolFailureGuardSnapshot) => void;
}

export interface ToolFailureRecordOptions {
	countTowardCircuit?: boolean;
}

export interface RepeatedToolFailureDecision {
	message: string;
	terminate: boolean;
}

const MAX_ERROR_SIGNATURE_CHARACTERS = 600;
const MAX_ERROR_SOURCE_CHARACTERS = 2_400;
const MAX_FINGERPRINT_CHARACTERS = 16_000;
const MAX_REPEAT_LIMIT = 100;
const MAX_CONSECUTIVE_LIMIT = 100;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_TOOL_ERROR_CHARACTERS = 800;
const MAX_TOOL_ERROR_SOURCE_CHARACTERS = 4_000;

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

function clampInteger(value: number | undefined, maximum: number): number {
	return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value ?? 0))) : 0;
}

function normalizeToolName(name: string): string {
	return name.toLowerCase().slice(0, 200);
}

export function normalizeToolExecutionError(error: unknown): string {
	let source = "Tool execution failed";
	try {
		source = (error instanceof Error ? error.message : String(error)).slice(0, MAX_TOOL_ERROR_SOURCE_CHARACTERS);
	} catch {
		// Hostile thrown values must not break the final tool-error boundary.
	}
	const cleaned = source
		.replace(/\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
		.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "Authorization [redacted]")
		.replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
		.replace(
			/\b([a-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password))\s*[:=]\s*[^\s,;]+/gi,
			"$1=[redacted]",
		)
		.replace(/\bsk-[a-z0-9_-]{8,}/gi, "[redacted]")
		.replace(/\b(?:gh[opusr]_[a-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/gi, "[redacted]")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const text = cleaned || "Tool execution failed";
	const characters = Array.from(text);
	return characters.length <= MAX_TOOL_ERROR_CHARACTERS
		? text
		: `${characters.slice(0, MAX_TOOL_ERROR_CHARACTERS - 1).join("")}…`;
}

export class RepeatedToolFailureGuard {
	private readonly failures = new Map<string, FailureRecord>();
	private readonly toolCircuits = new Map<string, ToolCircuitRecord>();
	private readonly repeatLimit: number;
	private readonly consecutiveLimit: number;
	private readonly cooldownMs: number;
	private readonly timeoutMs: number;
	private readonly now: () => number;
	private readonly onChange: ((snapshot: ToolFailureGuardSnapshot) => void) | undefined;

	constructor(options: ToolFailureGuardOptions) {
		this.repeatLimit = clampInteger(options.repeatLimit, MAX_REPEAT_LIMIT);
		this.consecutiveLimit = clampInteger(options.consecutiveLimit, MAX_CONSECUTIVE_LIMIT);
		this.cooldownMs = clampInteger(options.cooldownMs, MAX_COOLDOWN_MS);
		this.timeoutMs = clampInteger(options.timeoutMs, MAX_TIMEOUT_MS);
		this.now = options.now ?? Date.now;
		this.onChange = options.onChange;
		this.publish();
	}

	reset(): void {
		this.failures.clear();
		this.toolCircuits.clear();
		this.publish();
	}

	getBlockDecision(toolCall: AgentToolCall): RepeatedToolFailureDecision | undefined {
		const circuitDecision = this.getCircuitDecision(toolCall);
		if (circuitDecision) return circuitDecision;
		if (this.repeatLimit === 0) return undefined;
		const fingerprint = callFingerprint(toolCall);
		if (!fingerprint) return undefined;
		const failure = this.failures.get(fingerprint);
		if (!failure || failure.count < this.repeatLimit) return undefined;
		failure.blockedAttempts++;
		this.publish();
		const terminate = failure.blockedAttempts > 1;
		const consequence = terminate
			? "The current agent run is stopping because the previous recovery instruction was ignored."
			: "Another unchanged attempt will stop the current agent run.";
		return {
			message: `Repeated tool call blocked: this exact ${toolCall.name} call already failed ${failure.count} times with the same error. Do not repeat it unchanged. Change the arguments, use another tool, or explain the blocker. ${consequence} Last error: ${failure.signature}`,
			terminate,
		};
	}

	record(
		toolCall: AgentToolCall,
		result: AgentToolResult<unknown>,
		isError: boolean,
		options: ToolFailureRecordOptions = {},
	): void {
		this.recordExactFailure(toolCall, result, isError);
		this.recordToolCircuit(toolCall, result, isError, options.countTowardCircuit === true);
		this.publish();
	}

	getSnapshot(): ToolFailureGuardSnapshot {
		const now = this.now();
		return {
			repeatLimit: this.repeatLimit,
			consecutiveLimit: this.consecutiveLimit,
			cooldownMs: this.cooldownMs,
			timeoutMs: this.timeoutMs,
			tools: [...this.toolCircuits.entries()]
				.map(([name, record]) => {
					const status: ToolCircuitStatus = record.halfOpen
						? "half-open"
						: record.openedAt === undefined
							? "closed"
							: "open";
					const retryAt = record.openedAt === undefined ? undefined : record.openedAt + this.cooldownMs;
					return {
						name,
						status,
						consecutiveFailures: record.consecutiveFailures,
						...(retryAt === undefined ? {} : { retryAt: Math.max(now, retryAt) }),
						lastError: record.lastError,
					};
				})
				.sort((left, right) => left.name.localeCompare(right.name)),
		};
	}

	private getCircuitDecision(toolCall: AgentToolCall): RepeatedToolFailureDecision | undefined {
		if (this.consecutiveLimit === 0) return undefined;
		const name = normalizeToolName(toolCall.name);
		const circuit = this.toolCircuits.get(name);
		if (!circuit || circuit.openedAt === undefined) return undefined;

		const remainingMs = circuit.openedAt + this.cooldownMs - this.now();
		if (remainingMs <= 0 && !circuit.halfOpen) {
			circuit.halfOpen = true;
			circuit.blockedAttempts = 0;
			this.publish();
			return undefined;
		}

		circuit.blockedAttempts++;
		this.publish();
		const terminate = circuit.blockedAttempts > 1;
		const recovery = circuit.halfOpen
			? "One recovery probe is already running. Use another tool."
			: `Retry in ${Math.max(1, Math.ceil(remainingMs / 1_000))}s or use another tool.`;
		return {
			message: `Tool ${toolCall.name} is temporarily unavailable after ${circuit.consecutiveFailures} consecutive failures. ${recovery}`,
			terminate,
		};
	}

	private recordExactFailure(toolCall: AgentToolCall, result: AgentToolResult<unknown>, isError: boolean): void {
		if (this.repeatLimit === 0) return;
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

	private recordToolCircuit(
		toolCall: AgentToolCall,
		result: AgentToolResult<unknown>,
		isError: boolean,
		countTowardCircuit: boolean,
	): void {
		if (this.consecutiveLimit === 0) return;
		const name = normalizeToolName(toolCall.name);
		const previous = this.toolCircuits.get(name);
		if (!isError) {
			this.toolCircuits.delete(name);
			return;
		}
		if (!countTowardCircuit) {
			if (previous?.halfOpen) previous.halfOpen = false;
			return;
		}

		const signature = errorSignature(result);
		if (!signature) {
			if (previous?.halfOpen) previous.halfOpen = false;
			return;
		}
		const halfOpenFailure = previous?.halfOpen === true;
		const consecutiveFailures = halfOpenFailure
			? Math.max(this.consecutiveLimit, previous.consecutiveFailures)
			: (previous?.consecutiveFailures ?? 0) + 1;
		this.toolCircuits.set(name, {
			blockedAttempts: 0,
			consecutiveFailures,
			halfOpen: false,
			lastError: signature,
			...(consecutiveFailures >= this.consecutiveLimit ? { openedAt: this.now() } : {}),
		});
	}

	private publish(): void {
		try {
			this.onChange?.(this.getSnapshot());
		} catch {
			// Diagnostics are best-effort and must not interfere with tool execution.
		}
	}
}
