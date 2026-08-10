import { describe, expect, it, vi } from "vitest";
import { bootstrap, isFastVersionCommand } from "../src/bootstrap.ts";

describe("bootstrap", () => {
	it("recognizes only standalone version commands", () => {
		expect(isFastVersionCommand(["--version"])).toBe(true);
		expect(isFastVersionCommand(["-v"])).toBe(true);
		expect(isFastVersionCommand(["auth", "--version"])).toBe(false);
		expect(isFastVersionCommand(["--version", "extra"])).toBe(false);
	});

	it("prints a standalone version without loading the application", async () => {
		const configureHttpDispatcher = vi.fn();
		const runMain = vi.fn();
		const writeVersion = vi.fn();

		await bootstrap(["--version"], { configureHttpDispatcher, runMain, writeVersion });

		expect(writeVersion).toHaveBeenCalledOnce();
		expect(configureHttpDispatcher).not.toHaveBeenCalled();
		expect(runMain).not.toHaveBeenCalled();
	});

	it("configures networking before running the application", async () => {
		const calls: string[] = [];
		await bootstrap([], {
			configureHttpDispatcher: () => calls.push("dispatcher"),
			runMain: async () => {
				calls.push("main");
			},
			writeVersion: vi.fn(),
		});

		expect(calls).toEqual(["dispatcher", "main"]);
	});
});
