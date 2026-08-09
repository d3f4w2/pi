import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { renderFileDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { GitChangedFile, GitOverview } from "./types.ts";

export type GitDashboardResult = { type: "close" } | { type: "diff"; path: string };

function stateLabel(file: GitChangedFile): string {
	if (file.conflicted) return "冲突";
	if (file.untracked) return "未跟踪";
	if (file.staged && file.unstaged) return "已暂存+又修改";
	if (file.staged) return "已暂存";
	return "未暂存";
}

class GitDashboard implements Component {
	private overview: GitOverview;
	private selectedIndex = 0;
	private busy = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onStageChange: (file: GitChangedFile, staged: boolean) => Promise<GitOverview>;
	private readonly onError: (message: string) => void;
	private readonly done: (result: GitDashboardResult) => void;

	constructor(
		overview: GitOverview,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		onStageChange: (file: GitChangedFile, staged: boolean) => Promise<GitOverview>,
		onError: (message: string) => void,
		done: (result: GitDashboardResult) => void,
	) {
		this.overview = overview;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.onStageChange = onStageChange;
		this.onError = onError;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const relation = this.overview.upstream
			? ` · ${this.overview.upstream} · ↑${this.overview.ahead} ↓${this.overview.behind}`
			: "";
		const lines = [
			this.theme.bold("Git 变更管理"),
			this.theme.fg("muted", `${this.overview.branch}${relation} · ${this.overview.files.length} 个变更`),
			this.theme.fg("dim", "↑/↓ 选择 · ← 取消暂存 · → 暂存 · Enter 查看 Diff · Esc 完成"),
			"",
		];
		if (this.overview.files.length === 0) lines.push(this.theme.fg("muted", "工作区没有变更。"));
		for (const [index, file] of this.overview.files.entries()) {
			const selected = index === this.selectedIndex;
			const marker = file.staged ? "暂存" : "工作区";
			const line = `${selected ? "›" : " "} [${marker}] ${file.path} · ${stateLabel(file)}`;
			lines.push(selected ? this.theme.fg("accent", line) : line);
		}
		if (this.busy) lines.push("", this.theme.fg("muted", "正在更新暂存区…"));
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
			this.selectedIndex = Math.min(this.overview.files.length - 1, this.selectedIndex + 1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done({ type: "close" });
			return;
		}
		const file = this.overview.files[this.selectedIndex];
		if (!file) return;
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done({ type: "diff", path: file.path });
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			if (file.staged) this.changeStage(file, false);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			if (!file.staged || file.unstaged) this.changeStage(file, true);
		}
	}

	private changeStage(file: GitChangedFile, staged: boolean): void {
		this.busy = true;
		this.tui.requestRender();
		void this.onStageChange(file, staged).then(
			(overview) => {
				this.overview = overview;
				this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, overview.files.length - 1));
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

class GitDiffViewer implements Component {
	private readonly renderedDiff: string;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;

	constructor(renderedDiff: string, keybindings: KeybindingsManager, done: () => void) {
		this.renderedDiff = renderedDiff;
		this.keybindings = keybindings;
		this.done = done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return ["Git Diff", "Enter/Esc 返回", "", ...this.renderedDiff.split("\n")].map((line) =>
			truncateToWidth(line, width, ""),
		);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
		}
	}
}

export function showGitDashboard(
	overview: GitOverview,
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	onStageChange: (file: GitChangedFile, staged: boolean) => Promise<GitOverview>,
	onError: (message: string) => void,
	done: (result: GitDashboardResult) => void,
): Component {
	return new GitDashboard(overview, tui, theme, keybindings, onStageChange, onError, done);
}

export function showGitDiff(
	diff: Parameters<typeof renderFileDiff>[0],
	keybindings: KeybindingsManager,
	done: () => void,
): Component {
	return new GitDiffViewer(renderFileDiff(diff, { expanded: false, maxLines: 50 }), keybindings, done);
}
