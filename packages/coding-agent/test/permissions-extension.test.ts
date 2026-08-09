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
import type { ToolApprovalSetting } from "../src/core/settings-manager.ts";
import toolsExtension from "../src/extensions/tools/index.ts";
import { showPermissionsManager } from "../src/extensions/tools/permissions-ui.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const tools = [
	{ name: "read", approval: "read" },
	{ name: "write", approval: "write" },
	{ name: "bash", approval: "exec" },
] as ToolInfo[];

function createUi(): { tui: TUI; theme: Theme; keybindings: KeybindingsManager } {
	return {
		tui: { requestRender: vi.fn() } as unknown as TUI,
		theme: {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as unknown as Theme,
		keybindings: {
			matches: (data: string, action: string) => data === action,
		} as unknown as KeybindingsManager,
	};
}

describe("permissions extension", () => {
	test("renders the mode, policies, risks, and short Chinese descriptions", () => {
		const { tui, theme, keybindings } = createUi();
		const manager = showPermissionsManager(
			tui,
			theme,
			keybindings,
			tools,
			"write",
			{ read: "allow", bash: "deny" },
			() => {},
		);

		const output = manager.render(60).join("\n");
		expect(output).toContain("当前模式：标准");
		expect(output).toContain("[始终允许/读] read");
		expect(output).toContain("[跟随模式/写] write");
		expect(output).toContain("[始终禁止/执行] bash");
		expect(output).toContain("读取文件内容");
	});

	test("uses left and right to cycle a draft and enter saves it", () => {
		const { tui, theme, keybindings } = createUi();
		let result: Readonly<Record<string, ToolApprovalSetting>> | undefined;
		const manager = showPermissionsManager(tui, theme, keybindings, tools, "yolo", {}, (value) => {
			result = value;
		});

		manager.handleInput?.("tui.editor.cursorRight");
		manager.handleInput?.("tui.select.down");
		manager.handleInput?.("tui.editor.cursorLeft");
		manager.handleInput?.("tui.select.confirm");

		expect(result).toEqual({ read: "prompt", write: "deny" });
		expect(tui.requestRender).toHaveBeenCalled();
	});

	test("escape cancels draft changes and every line fits the terminal", () => {
		const { tui, theme, keybindings } = createUi();
		let result: Readonly<Record<string, ToolApprovalSetting>> | undefined = { read: "allow" };
		const manager = showPermissionsManager(tui, theme, keybindings, tools, "always-ask", {}, (value) => {
			result = value;
		});

		manager.handleInput?.("tui.editor.cursorRight");
		manager.handleInput?.("tui.select.cancel");

		expect(result).toBeUndefined();
		for (const line of manager.render(32)) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
	});

	test("registers /permissions and persists only changed policies", async () => {
		const commands = new Map<string, RegisteredCommand["handler"]>();
		const setToolApprovalPolicy = vi.fn();
		const pi = {
			registerTool: () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				commands.set(name, command.handler);
			},
			on: () => {},
			getAllTools: () => tools,
			getActiveTools: () => tools.map((tool) => tool.name),
		} as unknown as ExtensionAPI;
		toolsExtension(pi);

		const custom = async (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: Readonly<Record<string, ToolApprovalSetting>> | undefined) => void,
			) => Component | Promise<Component>,
		): Promise<Readonly<Record<string, ToolApprovalSetting>> | undefined> => {
			let result: Readonly<Record<string, ToolApprovalSetting>> | undefined;
			const { tui, theme, keybindings } = createUi();
			const component = await factory(tui, theme, keybindings, (value) => {
				result = value;
			});
			component.handleInput?.("tui.editor.cursorRight");
			component.handleInput?.("tui.select.confirm");
			return result;
		};
		const ctx = {
			getToolApprovalSettings: () => ({ mode: "write" as const, policies: { read: "allow" as const } }),
			setToolApprovalPolicy,
			ui: { custom, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		expect(commands.has("permissions")).toBe(true);
		await commands.get("permissions")?.("", ctx);

		expect(setToolApprovalPolicy).toHaveBeenCalledOnce();
		expect(setToolApprovalPolicy).toHaveBeenCalledWith("read", "deny");
	});

	test("escape does not persist permission changes", async () => {
		const commands = new Map<string, RegisteredCommand["handler"]>();
		const setToolApprovalPolicy = vi.fn();
		const pi = {
			registerTool: () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				commands.set(name, command.handler);
			},
			on: () => {},
			getAllTools: () => tools,
			getActiveTools: () => tools.map((tool) => tool.name),
		} as unknown as ExtensionAPI;
		toolsExtension(pi);

		const custom = async (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: Readonly<Record<string, ToolApprovalSetting>> | undefined) => void,
			) => Component | Promise<Component>,
		): Promise<Readonly<Record<string, ToolApprovalSetting>> | undefined> => {
			let result: Readonly<Record<string, ToolApprovalSetting>> | undefined;
			const { tui, theme, keybindings } = createUi();
			const component = await factory(tui, theme, keybindings, (value) => {
				result = value;
			});
			component.handleInput?.("tui.editor.cursorRight");
			component.handleInput?.("tui.select.cancel");
			return result;
		};
		const ctx = {
			getToolApprovalSettings: () => ({ mode: "write" as const, policies: {} }),
			setToolApprovalPolicy,
			ui: { custom, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await commands.get("permissions")?.("", ctx);

		expect(setToolApprovalPolicy).not.toHaveBeenCalled();
	});
});
