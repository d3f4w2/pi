import type { ResponseCreateParamsStreaming, ResponseInput } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { isStatefulStorageSetupError, OpenAIResponsesState } from "../src/api/openai-responses-state.ts";

function params(input: ResponseInput, toolName = "read"): ResponseCreateParamsStreaming {
	return {
		model: "gpt-test",
		input,
		stream: true,
		store: true,
		tools: [{ type: "function", name: toolName, description: "read", parameters: {}, strict: false }],
	};
}

const system = { role: "developer" as const, content: "stable" };
const user = { role: "user" as const, content: [{ type: "input_text" as const, text: "one" }] };
const assistant = {
	type: "message" as const,
	role: "assistant" as const,
	status: "completed" as const,
	id: "msg_1",
	content: [{ type: "output_text" as const, text: "answer", annotations: [] }],
};

describe("OpenAIResponsesState", () => {
	it("sends only the exact delta after a covered input and output prefix", async () => {
		const state = new OpenAIResponsesState();
		const first = await state.prepare("session", params([system, user]));
		expect(first.chained).toBe(false);
		await state.commit(first, "resp_1", [assistant]);

		const toolResult = { type: "function_call_output" as const, call_id: "call_1", output: "ok" };
		const second = await state.prepare("session", params([system, user, assistant, toolResult]));

		expect(second.chained).toBe(true);
		expect(second.params.previous_response_id).toBe("resp_1");
		expect(second.params.input).toEqual([toolResult]);
		// The fallback payload remains complete and unchanged.
		expect(second.fullParams.input).toEqual([system, user, assistant, toolResult]);
	});

	it("uses a full request on prefix or non-input shape mismatch", async () => {
		const state = new OpenAIResponsesState();
		const first = await state.prepare("session", params([system, user]));
		await state.commit(first, "resp_1", [assistant]);

		expect((await state.prepare("session", params([system, { ...user, content: "changed" }]))).chained).toBe(false);
		expect((await state.prepare("session", params([system, user, assistant], "write"))).chained).toBe(false);
	});

	it("ignores cache-breakpoint metadata when checking covered semantic input", async () => {
		const state = new OpenAIResponsesState();
		const markedUser = {
			...user,
			content: [
				{
					type: "input_text" as const,
					text: "one",
					prompt_cache_breakpoint: { mode: "explicit" as const },
				},
			],
		};
		const first = await state.prepare("session", params([system, markedUser]));
		await state.commit(first, "resp_1", [assistant]);
		const next = await state.prepare("session", params([system, user, assistant, { ...user, content: "two" }]));

		expect(next.chained).toBe(true);
		expect(next.params.input).toEqual([{ ...user, content: "two" }]);
	});

	it("opens a circuit after three continuation failures while preserving full fallback", async () => {
		const state = new OpenAIResponsesState();
		let prepared = await state.prepare("session", params([system, user]));
		await state.commit(prepared, "resp_1", [assistant]);
		const nextInput: ResponseInput = [
			system,
			user,
			assistant,
			{ role: "user", content: [{ type: "input_text", text: "two" }] },
		];

		for (let failure = 0; failure < 3; failure++) {
			prepared = await state.prepare("session", params(nextInput));
			expect(prepared.chained).toBe(true);
			state.recordContinuationFailure(prepared);
		}

		const disabled = await state.prepare("session", params(nextInput));
		expect(disabled.chained).toBe(false);
		expect(disabled.params.previous_response_id).toBeUndefined();
		expect(disabled.fullParams.input).toEqual(nextInput);
	});

	it("bounds session state with least-recent insertion eviction", async () => {
		const state = new OpenAIResponsesState(2);
		for (const key of ["a", "b", "c"]) {
			const prepared = await state.prepare(key, params([system, user]));
			await state.commit(prepared, `resp_${key}`, [assistant]);
		}
		expect(state.size).toBe(2);
		expect(state.has("a")).toBe(false);
		expect(state.has("b")).toBe(true);
		expect(state.has("c")).toBe(true);
	});

	it("retains only digests for covered prompts, outputs, and request shape", async () => {
		const state = new OpenAIResponsesState();
		const privateSystem = { role: "developer" as const, content: "private-system-secret" };
		const privateUser = {
			role: "user" as const,
			content: [{ type: "input_text" as const, text: "private-user-secret" }],
		};
		const privateAssistant = {
			...assistant,
			content: [{ type: "output_text" as const, text: "private-output-secret", annotations: [] }],
		};
		const prepared = await state.prepare("session", params([privateSystem, privateUser], "private-tool-secret"));
		await state.commit(prepared, "resp_private", [privateAssistant]);

		const internalState = state as unknown as {
			entries: Map<string, { coveredInput: string[]; shape: string }>;
		};
		const serialized = JSON.stringify([...internalState.entries]);
		expect(serialized).not.toContain("private-system-secret");
		expect(serialized).not.toContain("private-user-secret");
		expect(serialized).not.toContain("private-output-secret");
		expect(serialized).not.toContain("private-tool-secret");
	});

	it("disables provider storage for a rejected session and recognizes ZDR errors", async () => {
		const state = new OpenAIResponsesState();
		state.disable("session");
		const prepared = await state.prepare("session", params([system, user]));

		expect(prepared.params.store).toBe(false);
		expect(prepared.chained).toBe(false);
		const error = Object.assign(new Error("store is unavailable under zero data retention"), { status: 400 });
		expect(isStatefulStorageSetupError(error)).toBe(true);
		expect(isStatefulStorageSetupError(Object.assign(new Error("rate limit"), { status: 429 }))).toBe(false);
	});
});
