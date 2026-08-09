import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "./compaction/compaction.ts";

export interface ContextPruningSettings {
	enabled?: boolean;
	protectRecentTokens?: number;
	minimumSavingsTokens?: number;
	minimumResultTokens?: number;
	previewCharacters?: number;
}

export interface ResolvedContextPruningSettings {
	enabled: boolean;
	protectRecentTokens: number;
	minimumSavingsTokens: number;
	minimumResultTokens: number;
	previewCharacters: number;
}

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: ResolvedContextPruningSettings = {
	enabled: true,
	protectRecentTokens: 40_000,
	minimumSavingsTokens: 8_000,
	minimumResultTokens: 512,
	previewCharacters: 320,
};

export interface ContextPruningStats {
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
	prunedTokens: number;
	prunedResults: number;
	supersededResults: number;
}

export interface ContextPruningResult {
	messages: AgentMessage[];
	stats: ContextPruningStats;
}

interface ToolRequest {
	name: string;
	argumentsValue: unknown;
	requestKey: string | undefined;
}

interface PruningCandidate {
	index: number;
	replacement: ToolResultMessage<unknown>;
	originalTokens: number;
	replacementTokens: number;
	superseded: boolean;
}

function normalizedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export function resolveContextPruningSettings(settings: ContextPruningSettings = {}): ResolvedContextPruningSettings {
	return {
		enabled: typeof settings.enabled === "boolean" ? settings.enabled : DEFAULT_CONTEXT_PRUNING_SETTINGS.enabled,
		protectRecentTokens: normalizedInteger(
			settings.protectRecentTokens,
			DEFAULT_CONTEXT_PRUNING_SETTINGS.protectRecentTokens,
			0,
			10_000_000,
		),
		minimumSavingsTokens: normalizedInteger(
			settings.minimumSavingsTokens,
			DEFAULT_CONTEXT_PRUNING_SETTINGS.minimumSavingsTokens,
			0,
			10_000_000,
		),
		minimumResultTokens: normalizedInteger(
			settings.minimumResultTokens,
			DEFAULT_CONTEXT_PRUNING_SETTINGS.minimumResultTokens,
			1,
			1_000_000,
		),
		previewCharacters: normalizedInteger(
			settings.previewCharacters,
			DEFAULT_CONTEXT_PRUNING_SETTINGS.previewCharacters,
			0,
			1_000,
		),
	};
}

function canonicalJson(value: unknown, ancestors: Set<object>): string | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? JSON.stringify(value) : undefined;
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) return undefined;
		ancestors.add(value);
		const parts: string[] = [];
		for (const item of value) {
			const serialized = canonicalJson(item, ancestors);
			if (serialized === undefined) {
				ancestors.delete(value);
				return undefined;
			}
			parts.push(serialized);
		}
		ancestors.delete(value);
		return `[${parts.join(",")}]`;
	}
	if (typeof value !== "object") return undefined;
	if (ancestors.has(value)) return undefined;

	ancestors.add(value);
	const record = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of Object.keys(record).sort()) {
		const serialized = canonicalJson(record[key], ancestors);
		if (serialized === undefined) {
			ancestors.delete(value);
			return undefined;
		}
		parts.push(`${JSON.stringify(key)}:${serialized}`);
	}
	ancestors.delete(value);
	return `{${parts.join(",")}}`;
}

function requestKey(name: string, argumentsValue: unknown): string | undefined {
	const serialized = canonicalJson(argumentsValue, new Set());
	return serialized === undefined ? undefined : `${name.toLowerCase()}:${serialized}`;
}

function indexToolRequests(messages: readonly AgentMessage[]): Map<string, ToolRequest> {
	const requests = new Map<string, ToolRequest>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			requests.set(block.id, {
				name: block.name,
				argumentsValue: block.arguments,
				requestKey: requestKey(block.name, block.arguments),
			});
		}
	}
	return requests;
}

function getText(content: readonly ToolResultMessage["content"][number][]): string {
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function containsImage(message: ToolResultMessage): boolean {
	return message.content.some((part) => part.type === "image");
}

function getArgumentPath(argumentsValue: unknown): string | undefined {
	if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) return undefined;
	const record = argumentsValue as Record<string, unknown>;
	const candidate = record.path ?? record.file_path;
	return typeof candidate === "string" ? candidate.replaceAll("\\", "/").toLowerCase() : undefined;
}

function isInstructionResult(message: ToolResultMessage, request: ToolRequest | undefined): boolean {
	const toolName = (request?.name ?? message.toolName).toLowerCase();
	if (toolName === "skill" || toolName === "skills") return true;
	if (toolName !== "read") return false;

	const targetPath = getArgumentPath(request?.argumentsValue);
	if (!targetPath) return false;
	return (
		targetPath.startsWith("skill://") ||
		targetPath.endsWith("/agents.md") ||
		targetPath === "agents.md" ||
		targetPath.endsWith("/skill.md") ||
		targetPath === "skill.md"
	);
}

function createReplacement(
	message: ToolResultMessage<unknown>,
	request: ToolRequest | undefined,
	originalTokens: number,
	superseded: boolean,
	previewCharacters: number,
): ToolResultMessage<unknown> {
	const toolName = request?.name ?? message.toolName;
	let text: string;
	if (superseded) {
		text = `[Earlier ${toolName} output elided: about ${originalTokens} tokens. A newer result for the same ${toolName} request is available. Original remains in session history.]`;
	} else {
		const original = getText(message.content);
		const head = original.slice(0, previewCharacters);
		const tail = previewCharacters > 0 ? original.slice(-previewCharacters) : "";
		const preview = previewCharacters > 0 ? `\n\nPreview (head/tail):\n${head}\n...\n${tail}` : "";
		text = `[Earlier ${toolName} output compacted: about ${originalTokens} tokens. Re-run ${toolName} if exact output is needed. Original remains in session history.]${preview}`;
	}

	return {
		...message,
		content: [{ type: "text", text }],
	};
}

function emptyStats(messages: readonly AgentMessage[]): ContextPruningStats {
	const estimatedTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	return {
		estimatedTokensBefore: estimatedTokens,
		estimatedTokensAfter: estimatedTokens,
		prunedTokens: 0,
		prunedResults: 0,
		supersededResults: 0,
	};
}

export function pruneContextToolOutputs(
	messages: AgentMessage[],
	settingsInput: ContextPruningSettings | ResolvedContextPruningSettings = DEFAULT_CONTEXT_PRUNING_SETTINGS,
): ContextPruningResult {
	const settings = resolveContextPruningSettings(settingsInput);
	if (!settings.enabled) return { messages, stats: emptyStats(messages) };

	const requests = indexToolRequests(messages);
	const seenSuccessfulRequests = new Set<string>();
	const candidates: PruningCandidate[] = [];
	let recentTokens = 0;
	let seenToolResults = 0;

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult") continue;

		const request = requests.get(message.toolCallId);
		const key = request?.requestKey;
		const originalTokens = estimateTokens(message);
		const protectedByRecency = seenToolResults === 0 || recentTokens + originalTokens <= settings.protectRecentTokens;
		recentTokens += originalTokens;
		seenToolResults++;

		const superseded = !message.isError && key !== undefined && seenSuccessfulRequests.has(key);
		if (!message.isError && key !== undefined) seenSuccessfulRequests.add(key);

		if (
			protectedByRecency ||
			message.isError ||
			containsImage(message) ||
			isInstructionResult(message, request) ||
			originalTokens < settings.minimumResultTokens
		) {
			continue;
		}

		const replacement = createReplacement(message, request, originalTokens, superseded, settings.previewCharacters);
		const replacementTokens = estimateTokens(replacement);
		if (replacementTokens >= originalTokens) continue;
		candidates.push({ index, replacement, originalTokens, replacementTokens, superseded });
	}

	const projectedSavings = candidates.reduce(
		(sum, candidate) => sum + candidate.originalTokens - candidate.replacementTokens,
		0,
	);
	if (projectedSavings < settings.minimumSavingsTokens || candidates.length === 0) {
		return { messages, stats: emptyStats(messages) };
	}

	const transformed = [...messages];
	for (const candidate of candidates) transformed[candidate.index] = candidate.replacement;
	const estimatedTokensBefore = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	const estimatedTokensAfter = transformed.reduce((sum, message) => sum + estimateTokens(message), 0);

	return {
		messages: transformed,
		stats: {
			estimatedTokensBefore,
			estimatedTokensAfter,
			prunedTokens: estimatedTokensBefore - estimatedTokensAfter,
			prunedResults: candidates.length,
			supersededResults: candidates.filter((candidate) => candidate.superseded).length,
		},
	};
}
