import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import { APP_NAME, ENV_AGENT_DIR, ENV_MEMORY_FILE, ENV_SESSION_DIR } from "../src/config.ts";

describe("pigo command name", () => {
	it("publishes only the pigo executable while preserving PI configuration variables", () => {
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			bin?: Record<string, string>;
		};

		expect(packageJson.bin).toEqual({ pigo: "dist/bundle/cli.js" });
		expect(APP_NAME).toBe("pigo");
		expect(ENV_AGENT_DIR).toBe("PI_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("PI_CODING_AGENT_SESSION_DIR");
		expect(ENV_MEMORY_FILE).toBe("PI_MEMORY_FILE");
	});

	it("uses pigo in CLI help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp();
			const help = log.mock.calls.map(([message]) => String(message)).join("\n");
			expect(help).toContain("pigo [options] [@files...] [messages...]");
			expect(help).toContain("pigo doctor [--json]");
			expect(help).toContain("pigo run <task> [options]");
			expect(help).toContain("pigo ci [receipts...]");
			expect(help).not.toContain("\n  pi [options]");
		} finally {
			log.mockRestore();
		}
	});
});
