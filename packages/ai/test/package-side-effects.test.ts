import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("package side effects", () => {
	it("preserves image provider registration in source and published builds", () => {
		const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
			sideEffects?: string[];
		};

		expect(packageJson.sideEffects).toContain("./src/providers/images/register-builtins.ts");
		expect(packageJson.sideEffects).toContain("./dist/providers/images/register-builtins.js");
	});
});
