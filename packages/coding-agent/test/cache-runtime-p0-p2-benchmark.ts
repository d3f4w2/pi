import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ResponseCreateParamsStreaming, ResponseInput } from "openai/resources/responses/responses.js";
import { OpenAIResponsesState } from "../../ai/src/api/openai-responses-state.ts";
import {
	CACHE_DEVELOPER_CONTEXT_TYPE,
	type CustomMessage,
	convertToLlm,
	getMessageConversionMemoStats,
	resetMessageConversionMemoForTests,
} from "../src/core/messages.ts";

interface Args {
	sessions: string;
	provider: string;
	model: string;
}

interface UsageRecord {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

interface SessionAggregate {
	calls: number;
	promptTokens: number;
	cacheReadTokens: number;
	prefixGapUpperBoundTokens: number;
	firstPromptTokens: number;
	firstCacheReadTokens: number;
	subsequentCalls: number;
	subsequentPromptTokens: number;
	subsequentCacheReadTokens: number;
}

function parseArgs(argv: string[]): Args {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${name ?? ""}`);
		values.set(name.slice(2), value);
	}
	const sessions = values.get("sessions");
	if (!sessions) throw new Error("Usage: --sessions <directory> [--provider <id>] [--model <id>]");
	return {
		sessions: resolve(sessions),
		provider: values.get("provider") ?? "rayin-gpt",
		model: values.get("model") ?? "gpt-5.6-terra",
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readUsage(line: string, provider: string, model: string): UsageRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const entry = asRecord(parsed);
	const message = asRecord(entry?.message);
	if (
		entry?.type !== "message" ||
		message?.role !== "assistant" ||
		message.provider !== provider ||
		message.model !== model ||
		message.stopReason === "error" ||
		message.stopReason === "aborted"
	) {
		return undefined;
	}
	const usage = asRecord(message.usage);
	if (!usage) return undefined;
	return {
		input: tokenCount(usage.input),
		cacheRead: tokenCount(usage.cacheRead),
		cacheWrite: tokenCount(usage.cacheWrite),
	};
}

function auditSessions(args: Args): {
	sessionCount: number;
	callCount: number;
	promptTokens: number;
	cacheReadTokens: number;
	actualCacheReadRate: number;
	firstCallPromptTokens: number;
	firstCallCacheReadTokens: number;
	firstCallCacheReadRate: number;
	subsequentCallCount: number;
	subsequentPromptTokens: number;
	subsequentCacheReadTokens: number;
	subsequentCacheReadRate: number;
	prefixGapUpperBoundTokens: number;
	maximumRecoverableRate: number;
} {
	const longSessions: SessionAggregate[] = [];
	for (const name of readdirSync(args.sessions)) {
		if (!name.endsWith(".jsonl")) continue;
		const usages = readFileSync(join(args.sessions, name), "utf8")
			.split(/\r?\n/)
			.filter((line) => line.length > 0)
			.map((line) => readUsage(line, args.provider, args.model))
			.filter((usage): usage is UsageRecord => usage !== undefined);
		if (usages.length < 5) continue;

		let promptTokens = 0;
		let cacheReadTokens = 0;
		let prefixGapUpperBoundTokens = 0;
		let previousPromptTokens: number | undefined;
		for (const usage of usages) {
			const currentPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			promptTokens += currentPromptTokens;
			cacheReadTokens += usage.cacheRead;
			if (previousPromptTokens !== undefined) {
				prefixGapUpperBoundTokens += Math.max(
					0,
					Math.min(previousPromptTokens, currentPromptTokens) - usage.cacheRead,
				);
			}
			previousPromptTokens = currentPromptTokens;
		}
		const first = usages[0];
		const firstPromptTokens = first.input + first.cacheRead + first.cacheWrite;
		longSessions.push({
			calls: usages.length,
			promptTokens,
			cacheReadTokens,
			prefixGapUpperBoundTokens,
			firstPromptTokens,
			firstCacheReadTokens: first.cacheRead,
			subsequentCalls: usages.length - 1,
			subsequentPromptTokens: promptTokens - firstPromptTokens,
			subsequentCacheReadTokens: cacheReadTokens - first.cacheRead,
		});
	}

	const totals = longSessions.reduce(
		(result, session) => ({
			calls: result.calls + session.calls,
			promptTokens: result.promptTokens + session.promptTokens,
			cacheReadTokens: result.cacheReadTokens + session.cacheReadTokens,
			prefixGapUpperBoundTokens: result.prefixGapUpperBoundTokens + session.prefixGapUpperBoundTokens,
			firstPromptTokens: result.firstPromptTokens + session.firstPromptTokens,
			firstCacheReadTokens: result.firstCacheReadTokens + session.firstCacheReadTokens,
			subsequentCalls: result.subsequentCalls + session.subsequentCalls,
			subsequentPromptTokens: result.subsequentPromptTokens + session.subsequentPromptTokens,
			subsequentCacheReadTokens: result.subsequentCacheReadTokens + session.subsequentCacheReadTokens,
		}),
		{
			calls: 0,
			promptTokens: 0,
			cacheReadTokens: 0,
			prefixGapUpperBoundTokens: 0,
			firstPromptTokens: 0,
			firstCacheReadTokens: 0,
			subsequentCalls: 0,
			subsequentPromptTokens: 0,
			subsequentCacheReadTokens: 0,
		},
	);
	return {
		sessionCount: longSessions.length,
		callCount: totals.calls,
		promptTokens: totals.promptTokens,
		cacheReadTokens: totals.cacheReadTokens,
		actualCacheReadRate: totals.promptTokens > 0 ? totals.cacheReadTokens / totals.promptTokens : 0,
		firstCallPromptTokens: totals.firstPromptTokens,
		firstCallCacheReadTokens: totals.firstCacheReadTokens,
		firstCallCacheReadRate: totals.firstPromptTokens > 0 ? totals.firstCacheReadTokens / totals.firstPromptTokens : 0,
		subsequentCallCount: totals.subsequentCalls,
		subsequentPromptTokens: totals.subsequentPromptTokens,
		subsequentCacheReadTokens: totals.subsequentCacheReadTokens,
		subsequentCacheReadRate:
			totals.subsequentPromptTokens > 0 ? totals.subsequentCacheReadTokens / totals.subsequentPromptTokens : 0,
		prefixGapUpperBoundTokens: totals.prefixGapUpperBoundTokens,
		maximumRecoverableRate:
			totals.promptTokens > 0
				? Math.min(1, (totals.cacheReadTokens + totals.prefixGapUpperBoundTokens) / totals.promptTokens)
				: 0,
	};
}

function serializedItems(input: unknown[]): string[] {
	return input.map((item) => JSON.stringify(item));
}

function exactItemPrefixBytes(previous: unknown[], current: unknown[]): number {
	const left = serializedItems(previous);
	const right = serializedItems(current);
	let bytes = 0;
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		if (left[index] !== right[index]) break;
		bytes += Buffer.byteLength(left[index]);
	}
	return bytes;
}

function dynamicPrefixProof(): {
	rewrittenPrefixBytes: number;
	appendOnlyPrefixBytes: number;
	recoveredPrefixBytes: number;
} {
	const stable = "s".repeat(64 * 1024);
	const user = { role: "user", content: [{ type: "input_text", text: "u".repeat(32 * 1024) }] };
	const assistant = { role: "assistant", content: [{ type: "output_text", text: "answer" }] };
	const oldFirst = [{ role: "developer", content: `${stable}\nrevision-1` }, user];
	const oldSecond = [{ role: "developer", content: `${stable}\nrevision-2` }, user, assistant];
	const newFirst = [{ role: "developer", content: stable }, user, { role: "developer", content: "\nrevision-1" }];
	const newSecond = [
		{ role: "developer", content: stable },
		user,
		{ role: "developer", content: "\nrevision-1" },
		assistant,
		{ role: "user", content: [{ type: "input_text", text: "next" }] },
		{ role: "developer", content: "\nrevision-2" },
	];
	const rewrittenPrefixBytes = exactItemPrefixBytes(oldFirst, oldSecond);
	const appendOnlyPrefixBytes = exactItemPrefixBytes(newFirst, newSecond);
	return {
		rewrittenPrefixBytes,
		appendOnlyPrefixBytes,
		recoveredPrefixBytes: appendOnlyPrefixBytes - rewrittenPrefixBytes,
	};
}

async function statefulPayloadProof(): Promise<{ fullBytes: number; deltaBytes: number; uploadReductionRate: number }> {
	const state = new OpenAIResponsesState();
	const firstInput: ResponseInput = [
		{ role: "developer", content: "s".repeat(64 * 1024) },
		{ role: "user", content: [{ type: "input_text", text: "u".repeat(32 * 1024) }] },
	];
	const baseParams: ResponseCreateParamsStreaming = {
		model: "gpt-test",
		input: firstInput,
		stream: true,
		store: true,
	};
	const first = await state.prepare("benchmark", baseParams);
	const assistant = {
		type: "message" as const,
		role: "assistant" as const,
		status: "completed" as const,
		id: "msg_1",
		content: [{ type: "output_text" as const, text: "answer", annotations: [] }],
	};
	await state.commit(first, "resp_1", [assistant]);
	const nextUser = { role: "user" as const, content: [{ type: "input_text" as const, text: "n".repeat(2_048) }] };
	const second = await state.prepare("benchmark", {
		...baseParams,
		input: [...firstInput, assistant, nextUser],
	});
	const fullBytes = Buffer.byteLength(JSON.stringify(second.fullParams));
	const deltaBytes = Buffer.byteLength(JSON.stringify(second.params));
	return { fullBytes, deltaBytes, uploadReductionRate: 1 - deltaBytes / fullBytes };
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

function memoProof(): { uncachedMs: number; memoizedMs: number; speedup: number; hits: number; misses: number } {
	const content = Array.from({ length: 512 }, (_, index) => ({ type: "text" as const, text: `${index}-value` }));
	const message: CustomMessage = {
		role: "custom",
		customType: CACHE_DEVELOPER_CONTEXT_TYPE,
		content,
		display: false,
		timestamp: 1,
	};
	const iterations = 10_000;
	const uncachedRounds: number[] = [];
	const memoizedRounds: number[] = [];
	for (let round = 0; round < 5; round++) {
		let started = performance.now();
		for (let index = 0; index < iterations; index++) {
			content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
		}
		uncachedRounds.push(performance.now() - started);

		resetMessageConversionMemoForTests();
		convertToLlm([message], { cacheDeveloperContext: "sentinel" });
		started = performance.now();
		for (let index = 0; index < iterations; index++) {
			convertToLlm([message], { cacheDeveloperContext: "sentinel" });
		}
		memoizedRounds.push(performance.now() - started);
	}
	const uncachedMs = median(uncachedRounds);
	const memoizedMs = median(memoizedRounds);
	const stats = getMessageConversionMemoStats();
	return { uncachedMs, memoizedMs, speedup: uncachedMs / memoizedMs, ...stats };
}

const args = parseArgs(process.argv.slice(2));
const result = {
	mode: "offline-real-trace-replay",
	sessionScopeSha256: createHash("sha256").update(args.sessions).digest("hex"),
	providerModelSha256: createHash("sha256").update(`${args.provider}/${args.model}`).digest("hex"),
	historicalUsage: auditSessions(args),
	dynamicPrefixProof: dynamicPrefixProof(),
	statefulPayloadProof: await statefulPayloadProof(),
	memoProof: memoProof(),
	providerRequests: 0,
};
console.log(JSON.stringify(result, null, 2));
