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
	version: 1,
	tabId: "tab-1",
};

function fakeSession(): BrowserPageSession {
	return {
		status: vi.fn(async () => ({
			running: true,
			url: snapshot.url,
			title: snapshot.title,
			tabId: "tab-1",
			isolated: true,
		})),
		open: vi.fn(async () => snapshot),
		navigate: vi.fn(async () => snapshot),
		back: vi.fn(async () => snapshot),
		forward: vi.fn(async () => snapshot),
		reload: vi.fn(async () => snapshot),
		snapshot: vi.fn(async () => snapshot),
		click: vi.fn(async (_ref: string, version: number | undefined) => {
			if (version !== undefined && version !== snapshot.version) throw new Error("Snapshot reference is stale");
			return snapshot;
		}),
		type: vi.fn(async (_ref: string, version: number | undefined) => {
			if (version !== snapshot.version) throw new Error("Snapshot reference is stale");
			return snapshot;
		}),
		wait: vi.fn(async () => snapshot),
		hover: vi.fn(async (_ref: string, version: number | undefined) => {
			if (version !== snapshot.version) throw new Error("Snapshot reference is stale");
			return snapshot;
		}),
		press: vi.fn(async (_ref: string | undefined, version: number | undefined) => {
			if (version !== undefined && version !== snapshot.version) throw new Error("Snapshot reference is stale");
			return snapshot;
		}),
		select: vi.fn(async (_ref: string, version: number | undefined) => {
			if (version !== snapshot.version) throw new Error("Snapshot reference is stale");
			return snapshot;
		}),
		upload: vi.fn(async (_ref: string, version: number | undefined) => {
			if (version !== snapshot.version) throw new Error("Snapshot reference is stale");
			return snapshot;
		}),
		tabs: vi.fn(async () => [{ id: "tab-1", url: snapshot.url, title: snapshot.title, active: true }]),
		newTab: vi.fn(async () => snapshot),
		switchTab: vi.fn(async () => snapshot),
		closeTab: vi.fn(async (tabId: string) => {
			if (tabId !== "tab-1") throw new Error("Browser tab not found");
			return [];
		}),
		console: vi.fn(async () => []),
		errors: vi.fn(async () => ({ pageErrors: [], failedRequests: [] })),
		downloads: vi.fn(async () => []),
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
		expect(session.click).toHaveBeenCalledWith("e1", undefined, 300, undefined);
	});

	test("supports Browser 2.0 operations and rejects stale refs, unsafe tabs, and outside-workspace uploads", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "pi-browser-test-"));
		try {
			const uploadPath = path.join(workspace, "fixture.txt");
			await writeFile(uploadPath, "fixture");
			const session = fakeSession();
			const controller = new BrowserController(async () => session, workspace);
			await controller.open("http://localhost:3000");

			await expect(controller.navigate("http://localhost:3000/next")).resolves.toEqual(snapshot);
			await expect(controller.back()).resolves.toEqual(snapshot);
			await expect(controller.forward()).resolves.toEqual(snapshot);
			await expect(controller.reload()).resolves.toEqual(snapshot);
			await expect(controller.wait({ kind: "text", value: "Hello" }, 100)).resolves.toEqual(snapshot);
			await expect(controller.hover("e1", 1)).resolves.toEqual(snapshot);
			await expect(controller.press("e1", 1, "Enter")).resolves.toEqual(snapshot);
			await expect(controller.select("e1", 1, ["one"])).resolves.toEqual(snapshot);
			await expect(controller.upload("e1", 1, [uploadPath])).resolves.toEqual(snapshot);
			await expect(controller.tabs()).resolves.toHaveLength(1);
			await expect(controller.newTab("http://localhost:3000/new")).resolves.toEqual(snapshot);
			await expect(controller.switchTab("tab-1")).resolves.toEqual(snapshot);
			await expect(controller.closeTab("tab-1")).resolves.toEqual([]);
			await expect(controller.errors()).resolves.toEqual({ pageErrors: [], failedRequests: [] });
			await expect(controller.downloads()).resolves.toEqual([]);
			await expect(controller.screenshot(true)).resolves.toBe("cG5n");

			await expect(controller.hover("e1", 0)).rejects.toThrow("stale");
			await expect(controller.press("e1", 0, "Enter")).rejects.toThrow("stale");
			await expect(controller.select("e1", 0, ["one"])).rejects.toThrow("stale");
			await expect(controller.upload("e1", 0, [uploadPath])).rejects.toThrow("stale");
			await expect(controller.navigate("file:///outside")).rejects.toThrow("HTTP");
			await expect(controller.closeTab("missing")).rejects.toThrow("not found");
			await expect(controller.upload("e1", 1, [path.resolve(workspace, "..", "outside.txt")])).rejects.toThrow(
				"outside the workspace",
			);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
