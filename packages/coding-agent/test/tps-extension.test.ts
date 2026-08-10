import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import tpsExtension from "../../../.pi/extensions/tps.ts";

type Handler = (event: unknown, context: unknown) => unknown;

function createExtensionHarness() {
	const handlers = new Map<string, Handler[]>();
	const notify = vi.fn();
	const api = {
		on(event: string, handler: Handler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
	} as unknown as ExtensionAPI;

	tpsExtension(api);

	return {
		emit(event: string, payload: unknown = { type: event }) {
			for (const handler of handlers.get(event) ?? []) {
				handler(payload, { hasUI: true, ui: { notify } });
			}
		},
		notify,
	};
}

function assistantMessage(output: number) {
	return {
		role: "assistant",
		usage: {
			input: 50,
			output,
			cacheRead: 12_800,
			cacheWrite: 0,
			totalTokens: 12_850 + output,
		},
	};
}

describe("TPS extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	it("reports TTFT, active streaming throughput, and end-to-end latency separately", () => {
		const harness = createExtensionHarness();
		harness.emit("input", { type: "input", text: "hello", source: "interactive" });
		vi.setSystemTime(100);
		harness.emit("agent_start");

		vi.setSystemTime(2_100);
		harness.emit("message_start", { type: "message_start", message: assistantMessage(0) });
		harness.emit("message_update", {
			type: "message_update",
			message: assistantMessage(0),
			assistantMessageEvent: { type: "text_delta", delta: "a" },
		});
		vi.setSystemTime(4_100);
		harness.emit("message_update", {
			type: "message_update",
			message: assistantMessage(0),
			assistantMessageEvent: { type: "text_delta", delta: "b" },
		});
		harness.emit("message_end", { type: "message_end", message: assistantMessage(40) });

		// Tool execution time between assistant messages must not reduce streaming TPS.
		vi.setSystemTime(10_100);
		harness.emit("message_start", { type: "message_start", message: assistantMessage(0) });
		harness.emit("message_update", {
			type: "message_update",
			message: assistantMessage(0),
			assistantMessageEvent: { type: "thinking_delta", delta: "c" },
		});
		vi.setSystemTime(12_100);
		harness.emit("message_update", {
			type: "message_update",
			message: assistantMessage(0),
			assistantMessageEvent: { type: "toolcall_delta", delta: "d" },
		});
		harness.emit("message_end", { type: "message_end", message: assistantMessage(60) });

		vi.setSystemTime(13_000);
		harness.emit("agent_end", {
			type: "agent_end",
			messages: [assistantMessage(40), assistantMessage(60)],
		});

		expect(harness.notify).toHaveBeenCalledWith(
			"TTFT 2.1s, stream 25.0 tok/s, E2E 13.0s. out 100, in 100, cache r/w 25,600/0, total 25,800",
			"info",
		);
	});

	it("does not invent a streaming rate when there is no measurable delta interval", () => {
		const harness = createExtensionHarness();
		harness.emit("input", { type: "input", text: "hello", source: "interactive" });
		harness.emit("agent_start");
		vi.setSystemTime(1_000);
		harness.emit("message_update", {
			type: "message_update",
			message: assistantMessage(0),
			assistantMessageEvent: { type: "text_delta", delta: "only chunk" },
		});
		vi.setSystemTime(2_000);
		harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage(10)] });

		expect(harness.notify).toHaveBeenCalledWith(
			"TTFT 1.0s, stream n/a, E2E 2.0s. out 10, in 50, cache r/w 12,800/0, total 12,860",
			"info",
		);
	});
});
