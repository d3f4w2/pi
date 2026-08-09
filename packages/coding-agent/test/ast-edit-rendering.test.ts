import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Terminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { AstEditService } from "../src/extensions/ast-grep/edit.ts";
import { createAstGrepExtension } from "../src/extensions/ast-grep/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 110;
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

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ast_edit TUI preview", () => {
	test("renders a compact multi-file summary and shared file diffs", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-ast-edit-render-"));
		tempDirectories.push(directory);
		await writeFile(path.join(directory, "first.ts"), "console.log('first');\n", "utf8");
		await writeFile(path.join(directory, "second.ts"), "console.log('second');\n", "utf8");
		const tools: ToolDefinition[] = [];
		createAstGrepExtension(
			{ search: vi.fn() },
			new AstEditService(),
		)({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
		} as unknown as ExtensionAPI);
		const definition = tools.find((tool) => tool.name === "ast_edit");
		expect(definition).toBeDefined();

		const tui: TUI = new TuiMainScreen(new FakeTerminal());
		const component = new ToolExecutionComponent(
			"ast_edit",
			"ast-edit-preview",
			{
				pattern: "console.log($$$ARGS)",
				replacement: "logger.info($$$ARGS)",
				language: "typescript",
			},
			{},
			definition!,
			tui,
			directory,
		);
		tui.addChild(component);
		tui.start();
		component.setArgsComplete();

		let rendered = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			rendered = component.render(110).join("\n");
			if (rendered.includes("预览 2 个文件")) break;
		}

		expect(rendered).toContain("预览 2 个文件");
		expect(rendered).toContain("first.ts");
		expect(rendered).toContain("second.ts");
		expect(rendered).toContain("console.log");
		expect(rendered).toContain("logger.info");
	});
});
