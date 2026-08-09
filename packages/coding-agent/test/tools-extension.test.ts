import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	ToolDefinition,
	ToolInfo,
} from "../src/core/extensions/types.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import toolsExtension, { createToolsExtension } from "../src/extensions/tools/index.ts";
import type { ToolPreferencesStore } from "../src/extensions/tools/storage.ts";
import { showToolsManager } from "../src/extensions/tools/ui.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const tools = [{ name: "read" }, { name: "grep" }] as ToolInfo[];

describe("tools extension", () => {
	test("restores saved choices and hides discoverable tools when the session starts", async () => {
		let sessionStart: (() => Promise<void>) | undefined;
		let activeTools = ["read", "bash", "code_search", "tool_search"];
		const storage: ToolPreferencesStore = {
			load: async () => ({ enabledTools: ["grep"], disabledTools: ["bash"] }),
			recordChanges: async () => {},
		};
		const pi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			getAllTools: () =>
				[
					{ name: "read" },
					{ name: "bash" },
					{ name: "grep" },
					{ name: "code_search", discovery: { keywords: ["语义搜索"] } },
					{ name: "tool_search" },
				] as ToolInfo[],
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;

		createToolsExtension(storage)(pi);
		await sessionStart?.();

		expect(activeTools).toEqual(["read", "grep", "tool_search"]);
	});

	test("loads at most two matching tools and replaces the previous discovery", async () => {
		let sessionStart: (() => Promise<void>) | undefined;
		let registeredTool: ToolDefinition | undefined;
		let activeTools = ["read", "ast_grep", "web_search", "web_fetch", "tool_search"];
		const allTools = [
			{ name: "read" },
			{ name: "ast_grep", discovery: { keywords: ["代码结构"] } },
			{ name: "web_search", discovery: { keywords: ["网页", "最新资料"] } },
			{ name: "web_fetch", discovery: { keywords: ["网页", "读取网址"] } },
			{ name: "tool_search" },
		] as ToolInfo[];
		const storage: ToolPreferencesStore = {
			load: async () => ({ enabledTools: [], disabledTools: [] }),
			recordChanges: vi.fn(async () => {}),
		};
		const pi = {
			registerTool: (definition: ToolDefinition) => {
				registeredTool = definition;
			},
			registerCommand: () => {},
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			getAllTools: () => allTools,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;

		createToolsExtension(storage)(pi);
		await sessionStart?.();
		expect(activeTools).toEqual(["read", "tool_search"]);

		const webResult = await registeredTool?.execute(
			"search-web",
			{ query: "网页资料" },
			undefined,
			undefined,
			{} as ExtensionCommandContext,
		);
		expect(activeTools).toEqual(["read", "web_search", "web_fetch", "tool_search"]);
		expect(webResult?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("web_search") });

		await registeredTool?.execute(
			"search-structure",
			{ query: "代码结构" },
			undefined,
			undefined,
			{} as ExtensionCommandContext,
		);
		expect(activeTools).toEqual(["read", "ast_grep", "tool_search"]);
		expect(storage.recordChanges).not.toHaveBeenCalled();
	});

	test("restores all allowed tools when tool_search is disabled", async () => {
		let sessionStart: (() => Promise<void>) | undefined;
		let activeTools = ["read", "ast_grep", "verify", "tool_search"];
		const storage: ToolPreferencesStore = {
			load: async () => ({ enabledTools: [], disabledTools: ["tool_search"] }),
			recordChanges: async () => {},
		};
		const pi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_start") sessionStart = handler;
			},
			getAllTools: () =>
				[
					{ name: "read" },
					{ name: "ast_grep", discovery: { keywords: ["代码结构"] } },
					{ name: "verify", discovery: { keywords: ["检查修改"] } },
					{ name: "tool_search" },
				] as ToolInfo[],
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;

		createToolsExtension(storage)(pi);
		await sessionStart?.();

		expect(activeTools).toEqual(["read", "ast_grep", "verify"]);
	});

	test("adds newly registered tools to the allowed pool before applying discovery", async () => {
		const handlers = new Map<string, () => Promise<void> | void>();
		let registeredTool: ToolDefinition | undefined;
		let activeTools = ["read", "tool_search"];
		const allTools = [{ name: "read" }, { name: "tool_search" }] as ToolInfo[];
		const storage: ToolPreferencesStore = {
			load: async () => ({ enabledTools: [], disabledTools: [] }),
			recordChanges: async () => {},
		};
		const pi = {
			registerTool: (definition: ToolDefinition) => {
				registeredTool = definition;
			},
			registerCommand: () => {},
			on: (event: string, handler: () => Promise<void> | void) => {
				handlers.set(event, handler);
			},
			getAllTools: () => allTools,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		} as unknown as ExtensionAPI;

		createToolsExtension(storage)(pi);
		await handlers.get("session_start")?.();
		allTools.push({ name: "dynamic_docs", discovery: { keywords: ["生成文档"] } } as ToolInfo);
		activeTools.push("dynamic_docs");

		await handlers.get("before_agent_start")?.();
		expect(activeTools).toEqual(["read", "tool_search"]);

		await registeredTool?.execute(
			"find-dynamic-tool",
			{ query: "生成文档" },
			undefined,
			undefined,
			{} as ExtensionCommandContext,
		);
		expect(activeTools).toEqual(["read", "tool_search", "dynamic_docs"]);
	});

	test("registers the /tools command", async () => {
		let commandName: string | undefined;
		let handler: RegisteredCommand["handler"] | undefined;
		const custom = vi.fn(async () => undefined);
		const pi = {
			registerTool: () => {},
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
			registerTool: () => {},
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
			registerTool: () => {},
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
			registerTool: () => {},
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

	test("explains process lifecycle and isolated browser setup after they are enabled", async () => {
		let handler: RegisteredCommand["handler"] | undefined;
		let activeTools = ["read"];
		const notify = vi.fn();
		const managedTools = [{ name: "read" }, { name: "process" }, { name: "browser" }] as ToolInfo[];
		const pi = {
			registerTool: () => {},
			registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				handler = command.handler;
			},
			on: () => {},
			getAllTools: () => managedTools,
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
			component.handleInput?.("tui.select.down");
			component.handleInput?.("tui.editor.cursorRight");
			component.handleInput?.("tui.select.confirm");
		};

		await handler?.("", { ui: { custom, notify } } as unknown as ExtensionCommandContext);

		expect(activeTools).toEqual(["read", "process", "browser"]);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("日志按游标增量读取"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("退出 Pi 时会自动停止"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("临时隔离配置"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("PI_BROWSER_EXECUTABLE"), "info");
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
			registerTool: () => {},
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
		expect(lines.join("\n")).toContain("[开/读] read");
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
