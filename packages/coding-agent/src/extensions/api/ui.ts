import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ApiProviderDraft } from "./types.ts";

export type ApiDashboardResult = { type: "new" } | { type: "edit"; providerId: string } | { type: "close" };

function padToWidth(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

class ApiDashboard implements Component {
	private readonly providers: readonly ApiProviderDraft[];
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly tui: TUI;
	private readonly done: (result: ApiDashboardResult) => void;
	private activeColumn: "actions" | "providers" = "actions";
	private actionIndex = 0;
	private providerIndex = 0;

	constructor(
		providers: readonly ApiProviderDraft[],
		theme: Theme,
		keybindings: KeybindingsManager,
		tui: TUI,
		done: (result: ApiDashboardResult) => void,
	) {
		this.providers = providers;
		this.theme = theme;
		this.keybindings = keybindings;
		this.tui = tui;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 2);
		const leftWidth = Math.max(16, Math.floor((innerWidth - 3) / 2));
		const rightWidth = Math.max(16, innerWidth - leftWidth - 3);
		const lines = [
			this.theme.fg("accent", `┌${"─".repeat(innerWidth)}┐`),
			this.theme.fg("accent", `│${padToWidth(this.theme.bold(" API 供应商管理"), innerWidth)}│`),
			this.theme.fg("dim", `│${padToWidth("←/→ 切换区域 · ↑/↓ 选择 · Enter 确认 · Esc 关闭", innerWidth)}│`),
			this.theme.fg("border", `├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`),
			this.columnLine(" 操作", " 已配置供应商", leftWidth, rightWidth),
			this.columnLine(this.actionLabel(), this.providerLabel(), leftWidth, rightWidth),
		];
		const rows = Math.max(3, this.providers.length);
		for (let index = 1; index < rows; index++) {
			lines.push(this.columnLine("", this.providerLabel(index), leftWidth, rightWidth));
		}
		lines.push(this.theme.fg("accent", `└${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┘`));
		return lines;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.activeColumn = "actions";
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			if (this.providers.length > 0) this.activeColumn = "providers";
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.activeColumn === "actions") this.actionIndex = 0;
			else this.providerIndex = Math.max(0, this.providerIndex - 1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.activeColumn === "actions") this.actionIndex = 0;
			else this.providerIndex = Math.min(this.providers.length - 1, this.providerIndex + 1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done({ type: "close" });
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.activeColumn === "actions") this.done({ type: "new" });
			else {
				const provider = this.providers[this.providerIndex];
				if (provider) this.done({ type: "edit", providerId: provider.id });
			}
		}
	}

	private actionLabel(): string {
		const prefix = this.activeColumn === "actions" && this.actionIndex === 0 ? "› " : "  ";
		const value = `${prefix}新增供应商`;
		return this.activeColumn === "actions" ? this.theme.fg("accent", value) : value;
	}

	private providerLabel(index: number = this.providerIndex): string {
		if (this.providers.length === 0) return index === 0 ? this.theme.fg("dim", "  暂无") : "";
		const provider = this.providers[index];
		if (!provider) return "";
		const prefix = this.activeColumn === "providers" && index === this.providerIndex ? "› " : "  ";
		const label = `${prefix}${provider.name} (${provider.models.length} 个模型)`;
		return this.activeColumn === "providers" && index === this.providerIndex ? this.theme.fg("accent", label) : label;
	}

	private columnLine(left: string, right: string, leftWidth: number, rightWidth: number): string {
		return `│${padToWidth(left, leftWidth)}│${padToWidth(right, rightWidth)}│`;
	}

	private requestRender(): void {
		this.tui.requestRender();
	}
}

export function showApiDashboard(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	providers: readonly ApiProviderDraft[],
	done: (result: ApiDashboardResult) => void,
): Component {
	return new ApiDashboard(providers, theme, keybindings, tui, done);
}
