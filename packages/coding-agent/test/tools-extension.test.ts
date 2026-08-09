import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	ToolInfo,
} from "../src/core/extensions/types.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import toolsExtension, { createToolsExtension } from "../src/extensions/tools/index.ts";
import type { ToolPreferencesStore } from "../src/extensions/tools/storage.ts";
import { showToolsManager } from "../src/extensions/tools/ui.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const tools = [{ name: "read" }, { name: "grep" }] as ToolInfo[];

describe("tools extension", () => {
	test("restores saved choices when the session starts", async () => {
		let sessionStart: (() => Promise<void>) | undefined;
		let activeTools = ["read", "bash", "code_search"];
		const storage: ToolPreferencesStore = {
			load: async () => ({ enabledTools: ["grep"], disabledTools: ["bash"] }),
			recordChanges: async () => {},
		};
		const pi = {
			registerCommand: () => {},
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "grep" }, { name: "code_search" }],
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;

		createToolsExtension(storage)(pi);
		await sessionStart?.();

		expect(activeTools).toEqual(["read", "code_search", "grep"]);
	});

	test("registers the /tools command", async () => {
		let commandName: string | undefined;
		let handler: RegisteredCommand["handler"] | undefined;
		const custom = vi.fn(async () => undefined);
		const pi = {
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				commandName = name;
				handler = command.handler;
			},
			on: () => {},
			getAllTools: () => tools,
			getActiveTools: () => ["read"],
		} as unknown as ExtensionAPI;
		toolsExtension(pi);

		const ctx = {
			ui: { custom },
		} as unknown as ExtensionCommandContext;

		expect(commandName).toBe("tools");
		expect(handler).toBeDefined();
		await handler?.("", ctx);
		expect(custom).toHaveBeenCalledOnce();
	});

	test("explains setup and wait time after code_search is enabled", async () => {
		let handler: RegisteredCommand["handler"] | undefined;
		let activeTools = ["read", "code_search"];
		const notify = vi.fn();
		const semanticTools = [{ name: "read" }, { name: "code_search" }] as ToolInfo[];
		const pi = {
			registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				handler = command.handler;
			},
			on: () => {},
			getAllTools: () => semanticTools,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;
		toolsExtension(pi);

		type CustomFactory = (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: undefined) => void,
		) => Component | Promise<Component>;
		const custom = async (factory: CustomFactory): Promise<void> => {
			const component = await factory(
				{ requestRender: () => {} } as unknown as TUI,
				{ bold: (text: string) => text, fg: (_color: string, text: string) => text } as unknown as Theme,
				{ matches: (data: string, action: string) => data === action } as unknown as KeybindingsManager,
				() => {},
			);
			component.handleInput?.("tui.select.down");
			component.handleInput?.("tui.editor.cursorRight");
			component.handleInput?.("tui.select.confirm");
		};
		const ctx = { ui: { custom, notify } } as unknown as ExtensionCommandContext;

		await handler?.("", ctx);

		expect(activeTools).toEqual(["read", "code_search"]);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("mgrep login"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("后台建立索引"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("不会阻塞当前任务"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("默认最多同步 5000 个文件"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining(".mgrepignore"), "info");
	});

	test("explains bundled TypeScript and optional Python and Go setup after lsp is enabled", async () => {
		let handler: RegisteredCommand["handler"] | undefined;
		let activeTools = ["read", "lsp"];
		const notify = vi.fn();
		const lspTools = [{ name: "read" }, { name: "lsp" }] as ToolInfo[];
		const pi = {
			registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				handler = command.handler;
			},
			on: () => {},
			getAllTools: () => lspTools,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;
		toolsExtension(pi);

		const custom = async (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: undefined) => void,
			) => Component | Promise<Component>,
		): Promise<void> => {
			const component = await factory(
				{ requestRender: () => {} } as unknown as TUI,
				{ bold: (text: string) => text, fg: (_color: string, text: string) => text } as unknown as Theme,
				{ matches: (data: string, action: string) => data === action } as unknown as KeybindingsManager,
				() => {},
			);
			component.handleInput?.("tui.select.down");
			component.handleInput?.("tui.editor.cursorRight");
			component.handleInput?.("tui.select.confirm");
		};

		await handler?.("", { ui: { custom, notify } } as unknown as ExtensionCommandContext);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("TypeScript/JavaScript 可以直接使用"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("pip install basedpyright"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("gopls@latest"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("不会占用模型上下文"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("不会阻塞任务"), "info");
	});

	test("explains verify language support and optional Python tools after it is enabled", async () => {
		let handler: RegisteredCommand["handler"] | undefined;
		let activeTools = ["read"];
		const notify = vi.fn();
		const verifyTools = [{ name: "read" }, { name: "verify" }] as ToolInfo[];
		const pi = {
			registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				handler = command.handler;
			},
			on: () => {},
			getAllTools: () => verifyTools,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;
		toolsExtension(pi);

		const custom = async (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: undefined) => void,
			) => Component | Promise<Component>,
		): Promise<void> => {
			const component = await factory(
				{ requestRender: () => {} } as unknown as TUI,
				{ bold: (text: string) => text, fg: (_color: string, text: string) => text } as unknown as Theme,
				{ matches: (data: string, action: string) => data === action } as unknown as KeybindingsManager,
				() => {},
			);
			component.handleInput?.("tui.select.down");
			component.handleInput?.("tui.editor.cursorRight");
			component.handleInput?.("tui.select.confirm");
		};

		await handler?.("", { ui: { custom, notify } } as unknown as ExtensionCommandContext);

		expect(activeTools).toEqual(["read", "verify"]);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("TypeScript/JavaScript"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("pip install basedpyright"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("不会擅自运行整个仓库测试"), "info");
	});

	test("saves tool changes after the manager closes", async () => {
		let handler: RegisteredCommand["handler"] | undefined;
		let activeTools = ["read"];
		const recordChanges = vi.fn(async () => {});
		const storage: ToolPreferencesStore = {
			load: async () => ({ enabledTools: [], disabledTools: [] }),
			recordChanges,
		};
		const pi = {
			registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				handler = command.handler;
			},
			on: () => {},
			getAllTools: () => tools,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;
		createToolsExtension(storage)(pi);

		const custom = async (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: undefined) => void,
			) => Component | Promise<Component>,
		): Promise<void> => {
			const component = await factory(
				{ requestRender: () => {} } as unknown as TUI,
				{ bold: (text: string) => text, fg: (_color: string, text: string) => text } as unknown as Theme,
				{ matches: (data: string, action: string) => data === action } as unknown as KeybindingsManager,
				() => {},
			);
			component.handleInput?.("tui.select.down");
			component.handleInput?.("tui.editor.cursorRight");
			component.handleInput?.("tui.select.confirm");
		};

		await handler?.("", { ui: { custom, notify: vi.fn() } } as unknown as ExtensionCommandContext);

		expect(activeTools).toEqual(["read", "grep"]);
		expect(recordChanges).toHaveBeenCalledWith([{ toolName: "grep", active: true }]);
	});

	test("uses left and right to change the selected tool", () => {
		const changes: Array<{ toolName: string; active: boolean }> = [];
		let finished = false;
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const theme = {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as unknown as Theme;
		const keybindings = {
			matches: (data: string, action: string) => data === action,
		} as unknown as KeybindingsManager;
		const manager = showToolsManager(
			tui,
			theme,
			keybindings,
			tools,
			["read"],
			(toolName, active) => changes.push({ toolName, active }),
			() => {
				finished = true;
			},
		);

		manager.handleInput?.("tui.select.down");
		manager.handleInput?.("tui.editor.cursorRight");
		manager.handleInput?.("tui.editor.cursorLeft");
		manager.handleInput?.("tui.select.confirm");

		expect(changes).toEqual([
			{ toolName: "grep", active: true },
			{ toolName: "grep", active: false },
		]);
		expect(finished).toBe(true);
	});

	test("renders short Chinese descriptions within the terminal width", () => {
		const manager = showToolsManager(
			{ requestRender: () => {} } as unknown as TUI,
			{
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
			} as unknown as Theme,
			{ matches: () => false } as unknown as KeybindingsManager,
			tools,
			["read"],
			() => {},
			() => {},
		);
		const lines = manager.render(32);

		expect(lines.join("\n")).toContain("读取文件内容");
		expect(lines.join("\n")).toContain("搜索文件里的文字");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
	});

	test("shows a short Chinese description for ast_grep", () => {
		const manager = showToolsManager(
			{ requestRender: () => {} } as unknown as TUI,
			{
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
			} as unknown as Theme,
			{ matches: () => false } as unknown as KeybindingsManager,
			[{ name: "ast_grep" }] as ToolInfo[],
			[],
			() => {},
			() => {},
		);

		expect(manager.render(80).join("\n")).toContain("按代码结构精确搜索");
	});

	test("shows a short Chinese description for verify", () => {
		const manager = showToolsManager(
			{ requestRender: () => {} } as unknown as TUI,
			{
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
			} as unknown as Theme,
			{ matches: () => false } as unknown as KeybindingsManager,
			[{ name: "verify" }] as ToolInfo[],
			[],
			() => {},
			() => {},
		);

		expect(manager.render(80).join("\n")).toContain("运行相关检查和测试");
	});
});
