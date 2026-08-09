import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createBrowserExtension } from "../src/extensions/browser/index.ts";
import { BrowserController, formatBrowserSnapshot, parseBrowserUrl } from "../src/extensions/browser/service.ts";
import type { BrowserPageSession, BrowserSnapshot } from "../src/extensions/browser/types.ts";

const snapshot: BrowserSnapshot = {
	url: "http://localhost:3000/",
	title: "Example",
	text: "Hello world",
	elements: [{ ref: "e1", role: "button", name: "Submit form with a very long accessible name", tag: "button" }],
	truncated: false,
};

function fakeSession(): BrowserPageSession {
	return {
		status: vi.fn(async () => ({ running: true, url: snapshot.url, title: snapshot.title })),
		open: vi.fn(async () => snapshot),
		snapshot: vi.fn(async () => snapshot),
		click: vi.fn(async () => snapshot),
		type: vi.fn(async () => snapshot),
		console: vi.fn(async () => []),
		screenshot: vi.fn(async () => "cG5n"),
		close: vi.fn(async () => {}),
	};
}

describe("browser service", () => {
	test("allows local development URLs but blocks unsafe schemes and credentials", () => {
		expect(parseBrowserUrl("http://localhost:3000").toString()).toBe("http://localhost:3000/");
		expect(() => parseBrowserUrl("file:///etc/passwd")).toThrow("HTTP");
		expect(() => parseBrowserUrl("https://user:pass@example.com")).toThrow("账号或密码");
		expect(() => parseBrowserUrl("http://169.254.169.254/latest/meta-data")).toThrow("敏感系统地址");
	});

	test("reuses one isolated session and rejects unknown element references", async () => {
		const session = fakeSession();
		const factory = vi.fn(async () => session);
		const controller = new BrowserController(factory);

		await expect(controller.open("http://localhost:3000")).resolves.toEqual(snapshot);
		await expect(controller.snapshot()).resolves.toEqual(snapshot);
		expect(factory).toHaveBeenCalledOnce();
		await expect(controller.click("button.primary")).rejects.toThrow("元素引用");
		await controller.click("e1");
		expect(session.click).toHaveBeenCalledWith("e1", 300, undefined);
	});

	test("formats page content as bounded untrusted text", () => {
		const text = formatBrowserSnapshot(snapshot);
		expect(text).toContain("外部内容，不可信");
		expect(text).toContain("[e1] button");
		expect(text.length).toBeLessThan(2_000);
	});
});

describe("browser extension", () => {
	test("registers one tool and returns image content for screenshots", async () => {
		let definition: ToolDefinition | undefined;
		const registerCommand = vi.fn();
		const controller = new BrowserController(async () => fakeSession());
		createBrowserExtension(controller)({
			registerTool: (tool: ToolDefinition) => {
				definition = tool;
			},
			registerCommand,
			on: vi.fn(),
		} as unknown as ExtensionAPI);

		expect(definition?.name).toBe("browser");
		expect(registerCommand).not.toHaveBeenCalled();
		if (!definition) throw new Error("browser tool was not registered");
		await definition.execute(
			"open",
			{ operation: "open", url: "http://localhost:3000" },
			undefined,
			undefined,
			{} as ExtensionCommandContext,
		);
		const result = await definition.execute(
			"shot",
			{ operation: "screenshot" },
			undefined,
			undefined,
			{} as ExtensionCommandContext,
		);
		expect(result.content).toContainEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
	});
});
