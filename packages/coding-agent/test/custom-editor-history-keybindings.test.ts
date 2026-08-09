import { setKeybindings, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor prompt history keybindings", () => {
	it("renders a dynamic work mode inside the existing top border", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let label = "对话 · 标准";
		editor.setTopBorderLabel(() => label);

		for (const width of [40, 80]) {
			const lines = editor.render(width);
			expect(stripAnsi(lines[0] ?? "")).toContain("对话 · 标准");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		label = "终端 · 严格";
		expect(stripAnsi(editor.render(80)[0] ?? "")).toContain("终端 · 严格");
	});

	it("keeps the native top scroll indicator ahead of the mode label", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal(80, 12)), defaultEditorTheme, keybindings);
		editor.setTopBorderLabel(() => "对话 · 标准");
		editor.setText(Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n"));

		const topBorder = stripAnsi(editor.render(80)[0] ?? "");
		expect(topBorder).toContain("↑");
		expect(topBorder).not.toContain("对话");
	});

	it("gives an explicit history binding precedence over model cycling", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			modelCycles++;
		});
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("previous prompt");
		expect(modelCycles).toBe(0);

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("draft");
	});
});
