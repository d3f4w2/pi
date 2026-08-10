/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export const CACHE_DEVELOPER_CONTEXT_TYPE = "pi.cache.developer-context.v1";
export const CACHE_DEVELOPER_CONTEXT_SENTINEL = "<pi-cache-developer-context-v1>";
export const CACHE_DEVELOPER_CONTEXT_REVOCATION =
	"The previous dynamic developer context is no longer active. Ignore all earlier dynamic developer-context revisions.";

interface CacheDeveloperContextDetails {
	version: 1;
	active: boolean;
	digest?: string;
}

export interface DynamicDeveloperContextPlan {
	systemPrompt: string;
	/** Digest of the active suffix. Undefined when no suffix is active. */
	digest?: string;
	/** Internal three-state marker: undefined=no history, null=revoked, string=active digest. */
	state?: string | null;
	message?: CustomMessage<CacheDeveloperContextDetails>;
}

function cacheDeveloperContextMessage(
	content: string,
	details: CacheDeveloperContextDetails,
): CustomMessage<CacheDeveloperContextDetails> {
	return {
		role: "custom",
		customType: CACHE_DEVELOPER_CONTEXT_TYPE,
		content,
		display: false,
		details,
		timestamp: Date.now(),
	};
}

/**
 * Convert an exact appended system suffix into an append-only transcript item.
 * Ambiguous, unsupported, replaced, and prepended prompts retain the original
 * full system prompt.
 */
export function planDynamicDeveloperContext(
	baseSystemPrompt: string,
	effectiveSystemPrompt: string,
	previousState: string | null | undefined,
	eligible: boolean,
): DynamicDeveloperContextPlan {
	if (!eligible || baseSystemPrompt.length === 0) {
		return { systemPrompt: effectiveSystemPrompt };
	}
	if (effectiveSystemPrompt === baseSystemPrompt) {
		if (previousState === undefined || previousState === null) return { systemPrompt: baseSystemPrompt };
		return {
			systemPrompt: baseSystemPrompt,
			state: null,
			message: cacheDeveloperContextMessage(CACHE_DEVELOPER_CONTEXT_REVOCATION, {
				version: 1,
				active: false,
			}),
		};
	}
	if (!effectiveSystemPrompt.startsWith(baseSystemPrompt)) {
		if (previousState === undefined || previousState === null) return { systemPrompt: effectiveSystemPrompt };
		return {
			systemPrompt: effectiveSystemPrompt,
			state: null,
			message: cacheDeveloperContextMessage(CACHE_DEVELOPER_CONTEXT_REVOCATION, {
				version: 1,
				active: false,
			}),
		};
	}

	const suffix = effectiveSystemPrompt.slice(baseSystemPrompt.length);
	if (suffix.length === 0) {
		if (previousState === undefined || previousState === null) return { systemPrompt: baseSystemPrompt };
		return {
			systemPrompt: baseSystemPrompt,
			state: null,
			message: cacheDeveloperContextMessage(CACHE_DEVELOPER_CONTEXT_REVOCATION, {
				version: 1,
				active: false,
			}),
		};
	}

	const digest = createHash("sha256").update(suffix).digest("hex");
	if (digest === previousState) {
		return { systemPrompt: baseSystemPrompt, digest, state: digest };
	}
	const content = typeof previousState === "string" ? `${CACHE_DEVELOPER_CONTEXT_REVOCATION}\n\n${suffix}` : suffix;
	return {
		systemPrompt: baseSystemPrompt,
		digest,
		state: digest,
		message: cacheDeveloperContextMessage(content, { version: 1, active: true, digest }),
	};
}

/** Recover append-only state after resuming a persisted session. */
export function findCacheDeveloperContextState(messages: AgentMessage[]): string | null | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "custom" || message.customType !== CACHE_DEVELOPER_CONTEXT_TYPE) continue;
		const details = message.details;
		if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
		const record = details as Partial<CacheDeveloperContextDetails>;
		if (record.version !== 1) return undefined;
		return record.active === true && typeof record.digest === "string" ? record.digest : null;
	}
	return undefined;
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export interface ConvertToLlmOptions {
	cacheDeveloperContext?: "plain" | "sentinel" | "omit";
}

interface MessageConversionMemoEntry {
	content: CustomMessage["content"];
	customType: string;
	timestamp: number;
	result: Message | undefined;
}

let messageConversionMemo = new WeakMap<CustomMessage, Map<string, MessageConversionMemoEntry>>();
let messageConversionMemoHits = 0;
let messageConversionMemoMisses = 0;

export function getMessageConversionMemoStats(): { hits: number; misses: number } {
	return { hits: messageConversionMemoHits, misses: messageConversionMemoMisses };
}

export function resetMessageConversionMemoForTests(): void {
	messageConversionMemo = new WeakMap();
	messageConversionMemoHits = 0;
	messageConversionMemoMisses = 0;
}

function convertCustomMessage(m: CustomMessage, options: ConvertToLlmOptions): Message | undefined {
	const mode = m.customType === CACHE_DEVELOPER_CONTEXT_TYPE ? (options.cacheDeveloperContext ?? "plain") : "plain";
	const entries = messageConversionMemo.get(m);
	const cached = entries?.get(mode);
	if (
		cached &&
		cached.content === m.content &&
		cached.customType === m.customType &&
		cached.timestamp === m.timestamp
	) {
		messageConversionMemoHits++;
		return cached.result;
	}

	messageConversionMemoMisses++;
	let result: Message | undefined;
	if (m.customType === CACHE_DEVELOPER_CONTEXT_TYPE) {
		if (mode !== "omit") {
			const content =
				typeof m.content === "string"
					? m.content
					: m.content
							.filter((item): item is TextContent => item.type === "text")
							.map((item) => item.text)
							.join("\n");
			result = {
				role: "user",
				content: [
					{
						type: "text",
						text: mode === "sentinel" ? `${CACHE_DEVELOPER_CONTEXT_SENTINEL}${content}` : content,
					},
				],
				timestamp: m.timestamp,
			};
		}
	} else {
		const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
		result = { role: "user", content, timestamp: m.timestamp };
	}
	const nextEntries = entries ?? new Map<string, MessageConversionMemoEntry>();
	nextEntries.set(mode, { content: m.content, customType: m.customType, timestamp: m.timestamp, result });
	if (!entries) messageConversionMemo.set(m, nextEntries);
	return result;
}

export function convertToLlm(messages: AgentMessage[], options: ConvertToLlmOptions = {}): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					return convertCustomMessage(m, options);
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
