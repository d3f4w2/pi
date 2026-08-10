import { resolve } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { type CommandTask, type CommandTaskOutput, createCommandHarness } from "./command-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

function parseArgs(name: string, fallback: string[]): string[] {
	const value = process.env[name]?.trim();
	if (!value) return fallback;
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
		throw new TypeError(`${name} must be a JSON array of strings.`);
	}
	return parsed;
}

function repetitions(): number {
	const value = process.env.PI_OMP_COMPARE_REPETITIONS?.trim();
	if (!value) return 3;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new TypeError("PI_OMP_COMPARE_REPETITIONS must be a positive integer.");
	}
	return parsed;
}

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const enabled = process.env.PI_RUN_OMP_COMPARE === "1";
const baseline = createCommandHarness({
	name: "oh-my-pi",
	command: process.env.PI_OMP_COMMAND?.trim() || "omp",
	args: parseArgs("PI_OMP_ARGS_JSON", ["-p", "{prompt}"]),
	...(process.env.PI_OMP_AGENT_DIR?.trim()
		? { env: { PI_CODING_AGENT_DIR: process.env.PI_OMP_AGENT_DIR.trim() } }
		: {}),
});
const candidate = createCommandHarness({
	name: "pi-source",
	command: process.env.PI_COMPARE_COMMAND?.trim() || process.execPath,
	args: parseArgs("PI_COMPARE_ARGS_JSON", [
		resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
		resolve(repositoryRoot, "packages/coding-agent/src/cli.ts"),
		"-p",
		"{prompt}",
	]),
});
const harnessTable = evalHarnessTable("Pi versus OhMyPi command tasks", {
	baseline,
	candidate,
	repetitions: repetitions(),
});

const CommandTaskJudge = createJudge<CommandTask, CommandTaskOutput>("CommandTaskJudge", ({ output }) => ({
	score: output.passed ? 1 : 0,
	metadata: {
		rationale: output.passed
			? "All deterministic assertions passed without unexpected writes."
			: JSON.stringify({
					exitCode: output.exitCode,
					timedOut: output.timedOut,
					unexpectedWrites: output.unexpectedWrites,
					assertions: output.assertions.filter((assertion) => !assertion.passed),
				}),
	},
}));

const tasks: CommandTask[] = [
	{
		id: "exact-file-write",
		prompt: "Create answer.txt in the current directory containing exactly `verified` with no trailing newline.",
		allowedWrites: ["answer.txt"],
		assertions: [{ type: "fileEquals", path: "answer.txt", value: "verified" }],
	},
	{
		id: "single-file-bug-fix",
		prompt:
			"Fix the add function in math.ts so it returns the sum of a and b. Make the smallest change and do not create other files.",
		fixture: { "math.ts": "export function add(a: number, b: number): number {\n\treturn a - b;\n}\n" },
		allowedWrites: ["math.ts"],
		assertions: [{ type: "fileContains", path: "math.ts", value: "return a + b;" }],
	},
	{
		id: "cross-file-consistency",
		prompt:
			"Rename the exported function greet to welcome in greeting.ts and update its import and call in main.ts. Do not create other files.",
		fixture: {
			"greeting.ts": "export function greet(name: string): string {\n\treturn `Hello, $" + "{name}`;\n}\n",
			"main.ts": 'import { greet } from "./greeting.ts";\n\nconsole.log(greet("Ada"));\n',
		},
		allowedWrites: ["greeting.ts", "main.ts"],
		assertions: [
			{ type: "fileContains", path: "greeting.ts", value: "function welcome" },
			{ type: "fileContains", path: "main.ts", value: "import { welcome }" },
			{ type: "fileContains", path: "main.ts", value: 'welcome("Ada")' },
		],
	},
];

describe.skipIf(!enabled)("Pi versus OhMyPi", () => {
	describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
		describeEval(
			"Pi versus OhMyPi command tasks",
			{ harness, judges: [CommandTaskJudge], judgeThreshold: null },
			(it) => {
				for (const task of tasks) {
					it(task.id, async ({ run }) => {
						await run(task);
					});
				}
			},
		);
	});
});
