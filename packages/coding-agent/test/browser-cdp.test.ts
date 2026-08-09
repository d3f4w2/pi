import { describe, expect, test, vi } from "vitest";
import { CdpClient, type CdpTransport } from "../src/extensions/browser/cdp.ts";
import { browserExecutableCandidates } from "../src/extensions/browser/launcher.ts";

class FakeTransport implements CdpTransport {
	readonly sent: string[] = [];
	private readonly messageListeners = new Set<(message: string) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();

	send(message: string): void {
		this.sent.push(message);
	}

	onMessage(listener: (message: string) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		for (const listener of this.closeListeners) listener();
	}

	emit(message: unknown): void {
		for (const listener of this.messageListeners) listener(JSON.stringify(message));
	}
}

describe("CDP client", () => {
	test("correlates responses and delivers bounded events", async () => {
		const transport = new FakeTransport();
		const client = new CdpClient(transport);
		const events = vi.fn();
		client.on("Runtime.consoleAPICalled", events);

		const request = client.request<{ value: number }>("Runtime.evaluate", { expression: "1 + 1" });
		const sent = JSON.parse(transport.sent[0] ?? "{}") as { id: number };
		transport.emit({ method: "Runtime.consoleAPICalled", params: { type: "log" } });
		transport.emit({ id: sent.id, result: { value: 2 } });

		await expect(request).resolves.toEqual({ value: 2 });
		expect(events).toHaveBeenCalledWith({ type: "log" });
		client.close();
	});

	test("rejects pending requests when the connection closes", async () => {
		const transport = new FakeTransport();
		const client = new CdpClient(transport);
		const request = client.request("Page.navigate", { url: "https://example.com" });
		transport.close();
		await expect(request).rejects.toThrow("已关闭");
	});
});

describe("browser executable discovery", () => {
	test("prefers the configured executable and keeps platform fallbacks", () => {
		const candidates = browserExecutableCandidates(
			{ PI_BROWSER_EXECUTABLE: "C:/custom/browser.exe", ProgramFiles: "C:/Program Files" },
			"win32",
			(candidate) => candidate.includes("custom") || candidate.includes("Edge"),
		);
		expect(candidates[0]).toBe("C:/custom/browser.exe");
		expect(candidates).toContain("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
		expect(candidates).toContain("msedge.exe");
	});
});
