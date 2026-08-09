import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createProcessExtension, parseDirectCommandLine } from "../src/extensions/process/index.ts";
import type { BackgroundProcessService, ManagedProcessInfo } from "../src/extensions/process/types.ts";
import { showProcessManager } from "../src/extensions/process/ui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const running: ManagedProcessInfo = {
	id: "proc-1",
	label: "development server with a very long name",
	command: "npm",
	args: ["run", "dev"],
	cwd: "C:/repo",
	state: "running",
	startedAt: new Date(0).toISOString(),
	pid: 123,
	urls: ["http://localhost:3000"],
	logCursor: 2,
};

beforeAll(() => initTheme("dark"));

describe("process extension", () => {
	test("parses a direct command without enabling shell operators", () => {
		expect(parseDirectCommandLine('npm run dev -- --name "hello world"')).toEqual({
			command: "npm",
			args: ["run", "dev", "--", "--name", "hello world"],
		});
		expect(parseDirectCommandLine("npm run dev && echo unsafe")).toEqual({
			command: "npm",
			args: ["run", "dev", "&&", "echo", "unsafe"],
		});
		expect(() => parseDirectCommandLine('npm "unterminated')).toThrow("引号");
	});

	test("registers one tool with dynamic read and execution approval", () => {
		let definition: ToolDefinition | undefined;
		let commandName: string | undefined;
		const service = {
			start: vi.fn(),
			status: vi.fn(),
			logs: vi.fn(),
			restart: vi.fn(),
			stop: vi.fn(),
			stopAll: vi.fn(),
		} satisfies BackgroundProcessService;
		createProcessExtension(service)({
			registerTool: (tool: ToolDefinition) => {
				definition = tool;
			},
			registerCommand: (name: string) => {
				commandName = name;
			},
			on: vi.fn(),
		} as unknown as ExtensionAPI);

		expect(definition?.name).toBe("process");
		expect(commandName).toBe("process");
		if (typeof definition?.approval !== "function") throw new Error("process approval must be dynamic");
		expect(definition.approval({ operation: "status" })).toMatchObject({ tier: "read" });
		expect(definition.approval({ operation: "start" })).toMatchObject({ tier: "exec" });
	});

	test("renders safely and uses left to stop and right to restart", async () => {
		const onAction = vi.fn(async () => [running]);
		const requestRender = vi.fn();
		const component = showProcessManager(
			[running],
			{ requestRender } as unknown as TUI,
			theme,
			new KeybindingsManager(),
			onAction,
			vi.fn(),
			vi.fn(),
		);

		const lines = component.render(48);
		expect(lines.join("\n")).toContain("后台进程");
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
		component.handleInput?.("\x1b[D");
		await vi.waitFor(() => expect(onAction).toHaveBeenCalledWith("stop", "proc-1"));
		component.handleInput?.("\x1b[C");
		await vi.waitFor(() => expect(onAction).toHaveBeenCalledWith("restart", "proc-1"));
	});
});
