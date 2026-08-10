import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessContext } from "vitest-evals/harness";
import { createCommandHarness } from "../src/command-harness.ts";

function createContext(): HarnessContext {
	const artifacts: HarnessContext["artifacts"] = {};
	return {
		artifacts,
		setArtifact(name, value) {
			artifacts[name] = value;
		},
	};
}

describe("createCommandHarness", () => {
	it("passes prompts as argv, grades files, and records only allowed writes", async () => {
		const sentinel = join(process.cwd(), `command-harness-sentinel-${process.pid}`);
		const prompt = `literal; require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "bad")`;
		const harness = createCommandHarness({
			name: "argv-agent",
			command: process.execPath,
			args: [
				"-e",
				'const fs=require("node:fs"); fs.writeFileSync("result.txt", process.argv[1]); process.stdout.write("done");',
				"{prompt}",
			],
		});

		const result = await harness.run(
			{
				id: "argv-is-data",
				prompt,
				allowedWrites: ["result.txt"],
				assertions: [
					{ type: "stdoutIncludes", value: "done" },
					{ type: "fileEquals", path: "result.txt", value: prompt },
				],
			},
			createContext(),
		);

		expect(result.output).toMatchObject({
			passed: true,
			exitCode: 0,
			unexpectedWrites: [],
		});
		expect(existsSync(sentinel)).toBe(false);
	});

	it("fails a run that writes outside its task allowlist", async () => {
		const harness = createCommandHarness({
			name: "unsafe-agent",
			command: process.execPath,
			args: ["-e", 'require("node:fs").writeFileSync("unexpected.txt", "value")'],
		});

		const result = await harness.run({ id: "unexpected-write", prompt: "run", assertions: [] }, createContext());

		expect(result.output).toMatchObject({
			passed: false,
			unexpectedWrites: ["unexpected.txt"],
		});
	});

	it("terminates commands at the task timeout", async () => {
		const harness = createCommandHarness({
			name: "slow-agent",
			command: process.execPath,
			args: ["-e", "setTimeout(() => {}, 10_000)"],
		});

		const result = await harness.run(
			{ id: "timeout", prompt: "run", timeoutMs: 50, assertions: [] },
			createContext(),
		);

		expect(result.output).toMatchObject({ passed: false, timedOut: true });
	});
});
