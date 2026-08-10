import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

function isOutputDelta(type: string): boolean {
	return type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta";
}

export default function (pi: ExtensionAPI) {
	let pendingInputMs: number | null = null;
	let runStartMs: number | null = null;
	let firstOutputMs: number | null = null;
	let currentStreamStartMs: number | null = null;
	let currentStreamEndMs: number | null = null;
	let activeStreamingMs = 0;
	let activeStreamingOutput = 0;

	const finishCurrentStream = (outputTokens = 0) => {
		if (
			currentStreamStartMs !== null &&
			currentStreamEndMs !== null &&
			currentStreamEndMs > currentStreamStartMs
		) {
			activeStreamingMs += currentStreamEndMs - currentStreamStartMs;
			activeStreamingOutput += outputTokens;
		}
		currentStreamStartMs = null;
		currentStreamEndMs = null;
	};

	pi.on("input", () => {
		if (runStartMs === null) {
			pendingInputMs = Date.now();
		}
	});

	pi.on("agent_start", () => {
		runStartMs = pendingInputMs ?? Date.now();
		pendingInputMs = null;
		firstOutputMs = null;
		currentStreamStartMs = null;
		currentStreamEndMs = null;
		activeStreamingMs = 0;
		activeStreamingOutput = 0;
	});

	pi.on("message_start", (event) => {
		if (isAssistantMessage(event.message)) {
			finishCurrentStream();
		}
	});

	pi.on("message_update", (event) => {
		if (runStartMs === null || !isOutputDelta(event.assistantMessageEvent.type)) {
			return;
		}
		const now = Date.now();
		firstOutputMs ??= now;
		currentStreamStartMs ??= now;
		currentStreamEndMs = now;
	});

	pi.on("message_end", (event) => {
		if (isAssistantMessage(event.message)) {
			finishCurrentStream(event.message.usage.output || 0);
		}
	});

	pi.on("agent_end", (event, ctx) => {
		finishCurrentStream();
		const completedRunStartMs = runStartMs;
		const completedFirstOutputMs = firstOutputMs;
		const completedStreamingMs = activeStreamingMs;
		const completedStreamingOutput = activeStreamingOutput;
		runStartMs = null;
		firstOutputMs = null;
		activeStreamingMs = 0;
		activeStreamingOutput = 0;
		if (!ctx.hasUI || completedRunStartMs === null) return;

		const elapsedMs = Date.now() - completedRunStartMs;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
		}

		if (output <= 0) return;

		const ttft =
			completedFirstOutputMs === null ? "n/a" : `${((completedFirstOutputMs - completedRunStartMs) / 1000).toFixed(1)}s`;
		const streamTps =
			completedStreamingMs > 0
				? `${(completedStreamingOutput / (completedStreamingMs / 1000)).toFixed(1)} tok/s`
				: "n/a";
		const elapsedSeconds = elapsedMs / 1000;
		const message = `TTFT ${ttft}, stream ${streamTps}, E2E ${elapsedSeconds.toFixed(1)}s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}`;
		ctx.ui.notify(message, "info");
	});
}
