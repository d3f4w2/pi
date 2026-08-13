import { describe, expect, it, vi } from "vitest";
import {
	bootstrap,
	isCiCommand,
	isDoctorCommand,
	isFastHelpCommand,
	isFastVersionCommand,
	isRunCommand,
} from "../src/bootstrap.ts";

describe("bootstrap", () => {
	it("recognizes only standalone version commands", () => {
		expect(isFastVersionCommand(["--version"])).toBe(true);
		expect(isFastVersionCommand(["-v"])).toBe(true);
		expect(isFastVersionCommand(["auth", "--version"])).toBe(false);
		expect(isFastVersionCommand(["--version", "extra"])).toBe(false);
	});

	it("recognizes only standalone help commands", () => {
		expect(isFastHelpCommand(["--help"])).toBe(true);
		expect(isFastHelpCommand(["-h"])).toBe(true);
		expect(isFastHelpCommand(["auth", "--help"])).toBe(false);
		expect(isFastHelpCommand(["--help", "extra"])).toBe(false);
	});

	it("recognizes only top-level doctor commands", () => {
		expect(isDoctorCommand(["doctor"])).toBe(true);
		expect(isDoctorCommand(["doctor", "--json"])).toBe(true);
		expect(isDoctorCommand(["doctor", "--help"])).toBe(true);
		expect(isDoctorCommand(["doctoring"])).toBe(false);
		expect(isDoctorCommand(["--doctor"])).toBe(false);
	});

	it("recognizes standalone receipt commands", () => {
		expect(isRunCommand(["run", "task"])).toBe(true);
		expect(isRunCommand(["running"])).toBe(false);
		expect(isCiCommand(["ci", "receipts"])).toBe(true);
		expect(isCiCommand(["--ci"])).toBe(false);
	});

	it("prints a standalone version without loading the application", async () => {
		const configureHttpDispatcher = vi.fn();
		const runDoctor = vi.fn();
		const runMain = vi.fn();
		const writeHelp = vi.fn();
		const writeVersion = vi.fn();

		await bootstrap(["--version"], { configureHttpDispatcher, runDoctor, runMain, writeHelp, writeVersion });

		expect(writeVersion).toHaveBeenCalledOnce();
		expect(writeHelp).not.toHaveBeenCalled();
		expect(runDoctor).not.toHaveBeenCalled();
		expect(configureHttpDispatcher).not.toHaveBeenCalled();
		expect(runMain).not.toHaveBeenCalled();
	});

	it("prints standalone help without loading the application", async () => {
		const configureHttpDispatcher = vi.fn();
		const runDoctor = vi.fn();
		const runMain = vi.fn();
		const writeHelp = vi.fn();
		const writeVersion = vi.fn();

		await bootstrap(["--help"], { configureHttpDispatcher, runDoctor, runMain, writeHelp, writeVersion });

		expect(writeHelp).toHaveBeenCalledOnce();
		expect(writeVersion).not.toHaveBeenCalled();
		expect(runDoctor).not.toHaveBeenCalled();
		expect(configureHttpDispatcher).not.toHaveBeenCalled();
		expect(runMain).not.toHaveBeenCalled();
	});

	it("runs doctor without loading the application", async () => {
		const configureHttpDispatcher = vi.fn();
		const runDoctor = vi.fn();
		const runMain = vi.fn();
		const writeHelp = vi.fn();
		const writeVersion = vi.fn();

		await bootstrap(["doctor", "--json"], {
			configureHttpDispatcher,
			runDoctor,
			runMain,
			writeHelp,
			writeVersion,
		});

		expect(runDoctor).toHaveBeenCalledWith(["--json"]);
		expect(writeVersion).not.toHaveBeenCalled();
		expect(writeHelp).not.toHaveBeenCalled();
		expect(configureHttpDispatcher).not.toHaveBeenCalled();
		expect(runMain).not.toHaveBeenCalled();
	});

	it.each([
		["run", "runRun"],
		["ci", "runCi"],
	] as const)("runs %s without loading the application", async (command, handler) => {
		const configureHttpDispatcher = vi.fn();
		const runDoctor = vi.fn();
		const runMain = vi.fn();
		const runRun = vi.fn();
		const runCi = vi.fn();

		await bootstrap([command, "input"], {
			configureHttpDispatcher,
			runDoctor,
			runMain,
			runRun,
			runCi,
			writeHelp: vi.fn(),
			writeVersion: vi.fn(),
		});

		expect(handler === "runRun" ? runRun : runCi).toHaveBeenCalledWith(["input"]);
		expect(configureHttpDispatcher).not.toHaveBeenCalled();
		expect(runMain).not.toHaveBeenCalled();
	});

	it("configures networking before running the application", async () => {
		const calls: string[] = [];
		await bootstrap([], {
			configureHttpDispatcher: () => calls.push("dispatcher"),
			runDoctor: vi.fn(),
			runMain: async () => {
				calls.push("main");
			},
			writeHelp: vi.fn(),
			writeVersion: vi.fn(),
		});

		expect(calls).toEqual(["dispatcher", "main"]);
	});
});
