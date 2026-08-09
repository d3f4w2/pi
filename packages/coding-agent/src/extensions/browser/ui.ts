import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { BrowserSnapshot } from "./types.ts";

class BrowserSnapshotView implements Component {
	private readonly snapshot: BrowserSnapshot;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;

	constructor(snapshot: BrowserSnapshot, theme: Theme, keybindings: KeybindingsManager, done: () => void) {
		this.snapshot = snapshot;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [
			this.theme.bold("浏览器页面"),
			this.theme.fg("muted", `${this.snapshot.title || "(无标题)"} · ${this.snapshot.url}`),
			this.theme.fg("dim", "Enter/Esc 返回"),
			"",
			...this.snapshot.elements
				.slice(0, 30)
				.map((element) => `[${element.ref}] ${element.role} · ${element.name || "(无名称)"}`),
		];
		if (this.snapshot.elements.length === 0) lines.push(this.theme.fg("muted", "当前页面没有可操作元素。"));
		if (this.snapshot.truncated) lines.push("", this.theme.fg("muted", "页面内容较多，快照已截断。"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
		}
	}
}

export function showBrowserSnapshot(
	snapshot: BrowserSnapshot,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: () => void,
): Component {
	return new BrowserSnapshotView(snapshot, theme, keybindings, done);
}
