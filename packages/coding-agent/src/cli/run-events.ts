import type { RunTerminationReason, RunUsageEvidence } from "./run-receipt.ts";

export interface RunEventSummary {
	turns: number;
	toolCalls: Record<string, number>;
	toolErrors: number;
	usage: RunUsageEvidence;
	model?: { provider: string; id: string };
	finalResponse?: string;
	protocolErrors: number;
	agentEnded: boolean;
	agentFailed: boolean;
}

export interface RunEventBudget {
	maxTokens: number;
	maxToolCalls: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function assistantMessage(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) && value.role === "assistant" ? value : undefined;
}

function responseText(message: Record<string, unknown>): string | undefined {
	if (!Array.isArray(message.content)) return undefined;
	const chunks: string[] = [];
	for (const block of message.content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") chunks.push(block.text);
	}
	return chunks.length === 0 ? undefined : chunks.join("");
}

export class RunEventAccumulator {
	private turns = 0;
	private readonly toolCallCounts = new Map<string, number>();
	private toolErrors = 0;
	private readonly usage: RunUsageEvidence = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cost: 0,
	};
	private model: { provider: string; id: string } | undefined;
	private finalResponse: string | undefined;
	private protocolErrors = 0;
	private agentEnded = false;
	private agentFailed = false;

	private protocolError(): "protocol_error" {
		this.protocolErrors += 1;
		return "protocol_error";
	}

	private observeMessage(messageValue: unknown, includeUsage: boolean, includeResponse: boolean): boolean {
		const message = assistantMessage(messageValue);
		if (!message) return false;
		if (typeof message.provider === "string" && typeof message.model === "string") {
			this.model = { provider: message.provider, id: message.model };
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") this.agentFailed = true;
		if (includeResponse) {
			const text = responseText(message);
			if (text !== undefined) this.finalResponse = text;
		}
		if (includeUsage && isRecord(message.usage)) {
			const input = finiteNumber(message.usage.input);
			const output = finiteNumber(message.usage.output);
			const cacheRead = finiteNumber(message.usage.cacheRead);
			const cacheWrite = finiteNumber(message.usage.cacheWrite);
			this.usage.inputTokens += input;
			this.usage.outputTokens += output;
			this.usage.cacheReadTokens += cacheRead;
			this.usage.cacheWriteTokens += cacheWrite;
			this.usage.totalTokens += finiteNumber(message.usage.totalTokens) || input + output + cacheRead + cacheWrite;
			if (isRecord(message.usage.cost)) this.usage.cost += finiteNumber(message.usage.cost.total);
		}
		return true;
	}

	consumeLine(line: string): "ok" | "protocol_error" {
		if (line.trim().length === 0) return "ok";
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return this.protocolError();
		}
		if (!isRecord(value)) return this.protocolError();
		if (typeof value.type !== "string") return "ok";

		if (value.type === "tool_execution_start") {
			if (typeof value.toolName !== "string" || value.toolName.length === 0) return this.protocolError();
			this.toolCallCounts.set(value.toolName, (this.toolCallCounts.get(value.toolName) ?? 0) + 1);
			return "ok";
		}
		if (value.type === "tool_execution_end") {
			if (value.isError === true) this.toolErrors += 1;
			return "ok";
		}
		if (value.type === "message_end") {
			this.observeMessage(value.message, false, true);
			return "ok";
		}
		if (value.type === "turn_end") {
			if (this.observeMessage(value.message, true, false)) this.turns += 1;
			return "ok";
		}
		if (value.type === "agent_end") {
			this.agentEnded = true;
			return "ok";
		}
		return "ok";
	}

	exceededBudget(budget: RunEventBudget): Extract<RunTerminationReason, "token_budget" | "tool_budget"> | undefined {
		const toolCalls = [...this.toolCallCounts.values()].reduce((total, count) => total + count, 0);
		if (toolCalls > budget.maxToolCalls) return "tool_budget";
		if (this.usage.totalTokens > budget.maxTokens) return "token_budget";
		return undefined;
	}

	summary(): RunEventSummary {
		return {
			turns: this.turns,
			toolCalls: Object.fromEntries(
				[...this.toolCallCounts.entries()].sort(([first], [second]) => first.localeCompare(second)),
			),
			toolErrors: this.toolErrors,
			usage: { ...this.usage },
			...(this.model === undefined ? {} : { model: { ...this.model } }),
			...(this.finalResponse === undefined ? {} : { finalResponse: this.finalResponse }),
			protocolErrors: this.protocolErrors,
			agentEnded: this.agentEnded,
			agentFailed: this.agentFailed,
		};
	}
}
