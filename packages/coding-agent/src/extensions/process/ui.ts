import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ManagedProcessInfo } from "./types.ts";

export type ProcessManagerResult = { type: "close" } | { type: "logs"; id: string };
export type ProcessUiAction = "stop" | "restart";

function stateText(processInfo: ManagedProcessInfo): string {
	if (processInfo.state === "running") return "运行中";
	if (processInfo.state === "stopped") return "已停止";
	if (processInfo.state === "exited")
		return `已结束${processInfo.exitCode === undefined ? "" : `(${processInfo.exitCode})`}`;
	return `失败${processInfo.exitCode === undefined ? "" : `(${processInfo.exitCode})`}`;
}

class ProcessManagerView implements Component {
	private processes: ManagedProcessInfo[];
	private selectedIndex = 0;
	private busy = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onAction: (action: ProcessUiAction, id: string) => Promise<ManagedProcessInfo[]>;
	private readonly onError: (message: string) => void;
	private readonly done: (result: ProcessManagerResult) => void;

	constructor(
		processes: ManagedProcessInfo[],
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		onAction: (action: ProcessUiAction, id: string) => Promise<ManagedProcessInfo[]>,
		onError: (message: string) => void,
		done: (result: ProcessManagerResult) => void,
	) {
		this.processes = processes;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onAction = onAction;
		this.onError = onError;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const running = this.processes.filter((processInfo) => processInfo.state === "running").length;
		const lines = [
			this.theme.bold("后台进程"),
			this.theme.fg("muted", `${running} 个运行中 · 共 ${this.processes.length} 个记录`),
			this.theme.fg("dim", "↑/↓ 选择 · ← 停止 · → 重启 · Enter 日志 · Esc 完成"),
			"",
		];
		if (this.processes.length === 0) lines.push(this.theme.fg("muted", "还没有托管进程。"));
		for (const [index, processInfo] of this.processes.entries()) {
			const selected = index === this.selectedIndex;
			const url = processInfo.urls.at(-1);
			const line = `${selected ? "›" : " "} [${stateText(processInfo)}] ${processInfo.id} · ${processInfo.label}${url ? ` · ${url}` : ""}`;
			lines.push(selected ? this.theme.fg("accent", line) : line);
		}
		if (this.busy) lines.push("", this.theme.fg("muted", "正在更新进程…"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		if (this.busy) return;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, this.processes.length - 1), this.selectedIndex + 1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done({ type: "close" });
			return;
		}
		const processInfo = this.processes[this.selectedIndex];
		if (!processInfo) return;
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done({ type: "logs", id: processInfo.id });
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			if (processInfo.state === "running") this.change("stop", processInfo.id);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) this.change("restart", processInfo.id);
	}

	private change(action: ProcessUiAction, id: string): void {
		this.busy = true;
		this.tui.requestRender();
		void this.onAction(action, id).then(
			(processes) => {
				this.processes = processes;
				this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, processes.length - 1));
				this.busy = false;
				this.tui.requestRender();
			},
			(error: unknown) => {
				this.busy = false;
				this.onError(error instanceof Error ? error.message : String(error));
				this.tui.requestRender();
			},
		);
	}
}

class ProcessLogView implements Component {
	private readonly lines: string[];
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;

	constructor(text: string, keybindings: KeybindingsManager, done: () => void) {
		this.lines = text.split(/\r?\n/).slice(-30);
		this.keybindings = keybindings;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return ["进程日志", "Enter/Esc 返回", "", ...(this.lines.length > 0 ? this.lines : ["暂无日志。"])].map((line) =>
			truncateToWidth(line, width, ""),
		);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
		}
	}
}

export function showProcessManager(
	processes: ManagedProcessInfo[],
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	onAction: (action: ProcessUiAction, id: string) => Promise<ManagedProcessInfo[]>,
	onError: (message: string) => void,
	done: (result: ProcessManagerResult) => void,
): Component {
	return new ProcessManagerView(processes, tui, theme, keybindings, onAction, onError, done);
}

export function showProcessLogs(text: string, keybindings: KeybindingsManager, done: () => void): Component {
	return new ProcessLogView(text, keybindings, done);
}
