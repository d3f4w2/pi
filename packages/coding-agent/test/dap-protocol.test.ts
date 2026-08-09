import { describe, expect, it } from "vitest";
import { DapClient, DapMessageParser, encodeDapMessage } from "../src/extensions/debug/protocol.ts";
import type { DapMessage, DapTransport } from "../src/extensions/debug/types.ts";

class FakeTransport implements DapTransport {
	writes: Uint8Array[] = [];
	dataListener: ((data: Uint8Array) => void) | undefined;
	closeListener: ((error?: Error) => void) | undefined;

	write(data: Uint8Array): void {
		this.writes.push(data);
	}

	onData(listener: (data: Uint8Array) => void): void {
		this.dataListener = listener;
	}

	onClose(listener: (error?: Error) => void): void {
		this.closeListener = listener;
	}

	async dispose(): Promise<void> {}

	emit(message: DapMessage): void {
		this.dataListener?.(encodeDapMessage(message));
	}
}

describe("DAP protocol", () => {
	it("parses fragmented and adjacent Content-Length messages", () => {
		const first = encodeDapMessage({ seq: 1, type: "event", event: "initialized" });
		const second = encodeDapMessage({ seq: 2, type: "event", event: "stopped", body: { threadId: 7 } });
		const combined = Buffer.concat([Buffer.from(first), Buffer.from(second)]);
		const parser = new DapMessageParser();

		expect(parser.push(combined.subarray(0, 12))).toEqual([]);
		expect(parser.push(combined.subarray(12))).toEqual([
			{ seq: 1, type: "event", event: "initialized" },
			{ seq: 2, type: "event", event: "stopped", body: { threadId: 7 } },
		]);
	});

	it("correlates responses and preserves early events", async () => {
		const transport = new FakeTransport();
		const client = new DapClient(transport);
		transport.emit({ seq: 1, type: "event", event: "initialized" });
		const response = client.request("threads");
		const outgoing = new DapMessageParser().push(transport.writes[0] ?? new Uint8Array())[0];
		expect(outgoing).toMatchObject({ type: "request", command: "threads" });
		transport.emit({
			seq: 2,
			type: "response",
			request_seq: outgoing?.seq ?? 0,
			success: true,
			command: "threads",
			body: { threads: [{ id: 7 }] },
		});

		await expect(response).resolves.toMatchObject({ success: true, body: { threads: [{ id: 7 }] } });
		await expect(client.waitForEvent("initialized")).resolves.toMatchObject({ event: "initialized" });
	});

	it("rejects immediately when the transport cannot write", async () => {
		const transport = new FakeTransport();
		transport.write = () => {
			throw new Error("closed pipe");
		};
		const client = new DapClient(transport);
		await expect(client.request("threads")).rejects.toThrow("closed pipe");
	});
});
