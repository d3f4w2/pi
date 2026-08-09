import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Terminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 100;
	rows = 30;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

const tempDirectories: string[] = [];

async function renderWrite(cwd: string, filePath: string, content: string): Promise<string> {
	const tui: TUI = new TuiMainScreen(new FakeTerminal());
	const component = new ToolExecutionComponent(
		"write",
		"write-preview",
		{ path: filePath, content },
		{},
		createWriteToolDefinition(cwd),
		tui,
		cwd,
	);
	tui.addChild(component);
	tui.start();
	component.setArgsComplete();
	for (let attempt = 0; attempt < 20; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		const rendered = component.render(100).join("\n");
		if (rendered.includes("+1") || rendered.includes("新建")) return rendered;
	}
	return component.render(100).join("\n");
}

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("write tool diff preview", () => {
	test("shows removed and added content when overwriting a file", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-write-diff-"));
		tempDirectories.push(directory);
		await writeFile(path.join(directory, "example.ts"), "const value = 1;\n", "utf8");

		const rendered = await renderWrite(directory, "example.ts", "const value = 2;\n");
		expect(rendered).toContain("修改");
		expect(rendered).toContain("const value = 1");
		expect(rendered).toContain("const value = 2");
		expect(rendered).toContain("+1");
		expect(rendered).toContain("-1");
	});

	test("labels a missing target as a new file", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-write-diff-"));
		tempDirectories.push(directory);

		const rendered = await renderWrite(directory, "new.ts", "export {};\n");
		expect(rendered).toContain("新建");
		expect(rendered).toContain("export {}");
		expect(rendered).toContain("+1");
	});
});
