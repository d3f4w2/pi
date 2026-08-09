import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolInfo } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { getToolApprovalTier } from "../../core/tool-approval.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { getToolDescription } from "./discovery.ts";

class ToolsManager implements Component {
	private readonly tools: readonly ToolInfo[];
	private readonly activeTools: Set<string>;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly tui: TUI;
	private readonly onChange: (toolName: string, active: boolean) => void;
	private readonly done: () => void;
	private selectedIndex = 0;

	constructor(
		tools: readonly ToolInfo[],
		activeTools: readonly string[],
		theme: Theme,
		keybindings: KeybindingsManager,
		tui: TUI,
		onChange: (toolName: string, active: boolean) => void,
		done: () => void,
	) {
		this.tools = tools;
		this.activeTools = new Set(activeTools);
		this.theme = theme;
		this.keybindings = keybindings;
		this.tui = tui;
		this.onChange = onChange;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const lines = [
			this.theme.bold(this.theme.fg("accent", "工具管理")),
			this.theme.fg("dim", "读/写/执行=风险 · ↑/↓ 选择 · ← 关闭 · → 开启 · Enter/Esc 完成"),
			"",
		];
		for (const [index, tool] of this.tools.entries()) {
			const selected = index === this.selectedIndex;
			const active = this.activeTools.has(tool.name);
			const status = this.theme.fg(active ? "success" : "dim", active ? "开" : "关");
			const tier = getToolApprovalTier(tool);
			const risk = tier === "read" ? "读" : tier === "write" ? "写" : "执行";
			const riskText = this.theme.fg(tier === "read" ? "muted" : tier === "write" ? "warning" : "error", risk);
			const description = getToolDescription(tool.name);
			const cursor = selected ? this.theme.fg("accent", "›") : " ";
			const name = selected
				? this.theme.bold(this.theme.fg("accent", tool.name))
				: active
					? tool.name
					: this.theme.fg("dim", tool.name);
			lines.push(`${cursor} [${status}/${riskText}] ${name} ${this.theme.fg("muted", description)}`);
		}
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.tools.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.setSelectedTool(false);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			this.setSelectedTool(true);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
		}
	}

	private setSelectedTool(active: boolean): void {
		const tool = this.tools[this.selectedIndex];
		if (!tool) return;
		if (this.activeTools.has(tool.name) === active) {
			this.onChange(tool.name, active);
			return;
		}
		if (active) this.activeTools.add(tool.name);
		else this.activeTools.delete(tool.name);
		this.onChange(tool.name, active);
		this.tui.requestRender();
	}
}

export function showToolsManager(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	tools: readonly ToolInfo[],
	activeTools: readonly string[],
	onChange: (toolName: string, active: boolean) => void,
	done: () => void,
): Component {
	return new ToolsManager(tools, activeTools, theme, keybindings, tui, onChange, done);
}
