import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolInfo } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { ToolApprovalMode, ToolApprovalSetting } from "../../core/settings-manager.ts";
import { getToolApprovalTier } from "../../core/tool-approval.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { getToolDescription } from "./discovery.ts";

const POLICY_ORDER: readonly (ToolApprovalSetting | undefined)[] = [undefined, "prompt", "allow", "deny"];

function modeLabel(mode: ToolApprovalMode): string {
	if (mode === "always-ask") return "严格（每次使用都确认）";
	if (mode === "write") return "标准（修改和命令需要确认）";
	return "便捷（只确认危险操作）";
}

function policyLabel(policy: ToolApprovalSetting | undefined): string {
	if (policy === "prompt") return "每次询问";
	if (policy === "allow") return "始终允许";
	if (policy === "deny") return "始终禁止";
	return "跟随模式";
}

class PermissionsManager implements Component {
	private readonly tools: readonly ToolInfo[];
	private readonly policies = new Map<string, ToolApprovalSetting>();
	private readonly mode: ToolApprovalMode;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly tui: TUI;
	private readonly done: (result: Readonly<Record<string, ToolApprovalSetting>> | undefined) => void;
	private selectedIndex = 0;

	constructor(
		tools: readonly ToolInfo[],
		mode: ToolApprovalMode,
		policies: Readonly<Record<string, ToolApprovalSetting>>,
		theme: Theme,
		keybindings: KeybindingsManager,
		tui: TUI,
		done: (result: Readonly<Record<string, ToolApprovalSetting>> | undefined) => void,
	) {
		this.tools = tools;
		this.mode = mode;
		for (const [name, policy] of Object.entries(policies)) this.policies.set(name.toLowerCase(), policy);
		this.theme = theme;
		this.keybindings = keybindings;
		this.tui = tui;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const lines = [
			this.theme.bold(this.theme.fg("accent", "权限管理")),
			this.theme.fg("dim", `当前模式：${modeLabel(this.mode)}`),
			this.theme.fg("dim", "↑/↓ 选择 · ←/→ 修改 · Enter 保存 · Esc 取消"),
			"",
		];
		for (const [index, tool] of this.tools.entries()) {
			const selected = index === this.selectedIndex;
			const policy = this.policies.get(tool.name.toLowerCase());
			const tier = getToolApprovalTier(tool);
			const risk = tier === "read" ? "读" : tier === "write" ? "写" : "执行";
			const policyColor =
				policy === "allow" ? "success" : policy === "prompt" ? "warning" : policy === "deny" ? "error" : "dim";
			const policyText = this.theme.fg(policyColor, policyLabel(policy));
			const riskText = this.theme.fg(tier === "read" ? "muted" : tier === "write" ? "warning" : "error", risk);
			const cursor = selected ? this.theme.fg("accent", "›") : " ";
			const name = selected ? this.theme.bold(this.theme.fg("accent", tool.name)) : tool.name;
			const description = this.theme.fg("muted", getToolDescription(tool.name));
			lines.push(`${cursor} [${policyText}/${riskText}] ${name} ${description}`);
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
			this.cyclePolicy(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			this.cyclePolicy(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const result: Record<string, ToolApprovalSetting> = {};
			for (const [name, policy] of this.policies) result[name] = policy;
			this.done(result);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) this.done(undefined);
	}

	private cyclePolicy(direction: -1 | 1): void {
		const tool = this.tools[this.selectedIndex];
		if (!tool) return;
		const name = tool.name.toLowerCase();
		const current = this.policies.get(name);
		const currentIndex = POLICY_ORDER.indexOf(current);
		const nextIndex = (currentIndex + direction + POLICY_ORDER.length) % POLICY_ORDER.length;
		const next = POLICY_ORDER[nextIndex];
		if (next === undefined) this.policies.delete(name);
		else this.policies.set(name, next);
		this.tui.requestRender();
	}
}

export function showPermissionsManager(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	tools: readonly ToolInfo[],
	mode: ToolApprovalMode,
	policies: Readonly<Record<string, ToolApprovalSetting>>,
	done: (result: Readonly<Record<string, ToolApprovalSetting>> | undefined) => void,
): Component {
	return new PermissionsManager(tools, mode, policies, theme, keybindings, tui, done);
}
