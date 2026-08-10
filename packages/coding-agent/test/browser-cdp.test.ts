import { describe, expect, test, vi } from "vitest";
import { CdpClient, type CdpTransport } from "../src/extensions/browser/cdp.ts";
import { browserExecutableCandidates, parseExplicitCdpEndpoint } from "../src/extensions/browser/launcher.ts";
import { BrowserNetworkPolicy, parseBrowserHttpUrl } from "../src/extensions/browser/network-policy.ts";

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

test("accepts a screenshot response larger than the former 4 MB envelope", async () => {
	const transport = new FakeTransport();
	const client = new CdpClient(transport);
	const request = client.request<{ data: string }>("Page.captureScreenshot");
	const sent = JSON.parse(transport.sent[0] ?? "{}") as { id: number };
	const data = "A".repeat(5 * 1024 * 1024);

	transport.emit({ id: sent.id, result: { data } });

	await expect(request).resolves.toEqual({ data });
	client.close();
});

describe("browser network policy", () => {
	test("rejects metadata aliases and private IPv6 literals", () => {
		expect(() => parseBrowserHttpUrl("http://metadata.google.internal./")).toThrow(/metadata|private/i);
		expect(() => parseBrowserHttpUrl("http://[fd00:ec2::254]/latest/meta-data/")).toThrow(/metadata|private/i);
	});

	test("rejects private DNS answers and unauthorized loopback subrequests", async () => {
		const privatePolicy = new BrowserNetworkPolicy(async () => [{ address: "10.0.0.5", family: 4 }]);
		await expect(privatePolicy.authorizeNavigation("https://public.example.test/")).rejects.toThrow(/private/i);

		const loopbackPolicy = new BrowserNetworkPolicy();
		await loopbackPolicy.authorizeNavigation("http://127.0.0.1:3000/");
		await expect(loopbackPolicy.assertRequestAllowed("http://127.0.0.1:3000/app.js")).resolves.toBeUndefined();
		await expect(loopbackPolicy.assertRequestAllowed("http://127.0.0.1:3001/admin")).rejects.toThrow(
			/explicitly navigated/i,
		);
		await expect(loopbackPolicy.assertRequestAllowed("ws://127.0.0.1:3000/socket")).resolves.toBeUndefined();
		await expect(loopbackPolicy.assertRequestAllowed("ws://127.0.0.1:3001/socket")).rejects.toThrow(
			/explicitly navigated/i,
		);
	});

	test("allows only public DNS answers for ordinary browser hosts", async () => {
		const policy = new BrowserNetworkPolicy(async () => [{ address: "93.184.216.34", family: 4 }]);
		await expect(policy.authorizeNavigation("https://example.test/")).resolves.toBeInstanceOf(URL);
		await expect(policy.assertRequestAllowed("https://example.test/app.js")).resolves.toBeUndefined();
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

	test("connects existing Chrome only through an explicit loopback endpoint", () => {
		expect(parseExplicitCdpEndpoint("http://127.0.0.1:9222/json/version")).toBe("http://127.0.0.1:9222");
		expect(parseExplicitCdpEndpoint("http://localhost:9222")).toBe("http://localhost:9222");
		expect(() => parseExplicitCdpEndpoint("https://127.0.0.1:9222")).toThrow("loopback");
		expect(() => parseExplicitCdpEndpoint("http://user:secret@127.0.0.1:9222")).toThrow("credentials");
		expect(() => parseExplicitCdpEndpoint("http://192.168.1.2:9222")).toThrow("loopback");
	});
});
