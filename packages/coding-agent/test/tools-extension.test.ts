import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	ToolInfo,
} from "../src/core/extensions/types.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import toolsExtension from "../src/extensions/tools/index.ts";
import { showToolsManager } from "../src/extensions/tools/ui.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const tools = [{ name: "read" }, { name: "grep" }] as ToolInfo[];

describe("tools extension", () => {
	test("registers the /tools command", async () => {
		let commandName: string | undefined;
		let handler: RegisteredCommand["handler"] | undefined;
		const custom = vi.fn(async () => undefined);
		const pi = {
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				commandName = name;
				handler = command.handler;
			},
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
});
