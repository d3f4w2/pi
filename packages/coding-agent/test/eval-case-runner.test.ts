import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { runApprovedRegressionCase, selectApprovedRegressionCase } from "../src/extensions/evals/regression-runner.ts";
import type { ApprovedRegressionCase } from "../src/extensions/evals/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function workspace(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-eval-runner-"));
	temporaryDirectories.push(directory);
	await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n', "utf8");
	return directory;
}

function approvedCase(
	filePath: string,
	content: string,
	overrides: Partial<ApprovedRegressionCase> = {},
): ApprovedRegressionCase {
	return {
		version: 1,
		id: "case-001",
		title: "focused regression",
		category: "testing",
		approvedAt: "2026-08-09T00:00:00.000Z",
		source: {
			fingerprint: "tool-error",
			kind: "tool_error",
			summary: "tool recovered",
			detectedAt: "2026-08-09T00:00:00.000Z",
			recoveredAt: "2026-08-09T00:00:01.000Z",
		},
		reproduction: ["trigger failure"],
		expectedFailure: "fails",
		expectedSuccess: "passes",
		files: [
			{
				path: filePath,
				bytes: Buffer.byteLength(content, "utf8"),
				digest: createHash("sha256").update(content).digest("hex"),
			},
		],
		...overrides,
	};
}

async function createApprovedFile(root: string, filePath: string, content: string): Promise<ApprovedRegressionCase> {
	const absolutePath = path.join(root, filePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf8");
	return approvedCase(filePath, content);
}

describe("focused regression runner", () => {
	it("runs an approved TypeScript node:test file directly", async () => {
		const root = await workspace();
		const testCase = await createApprovedFile(
			root,
			"test/read.test.ts",
			'import test from "node:test";\ntest("read", () => {});\n',
		);
		const execute = vi.fn(async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }));
		const result = await runApprovedRegressionCase(root, testCase, execute);
		expect(result).toMatchObject({ passed: true, runner: "node:test" });
		expect(execute).toHaveBeenCalledWith(
			process.execPath,
			expect.arrayContaining(["--experimental-strip-types", "--test", path.join("test", "read.test.ts")]),
			expect.objectContaining({ cwd: root, timeout: 60_000 }),
		);
	});

	it("executes an approved node:test case end to end", async () => {
		const root = await workspace();
		const testCase = await createApprovedFile(
			root,
			"test/real.test.ts",
			'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("real", () => assert.equal(2 + 2, 4));\n',
		);
		const result = await runApprovedRegressionCase(root, testCase, (command, args, options) =>
			execCommand(command, args, options.cwd ?? root, options),
		);
		expect(result).toMatchObject({ passed: true, runner: "node:test", killed: false });
		expect(result.output).toContain("pass 1");
	});

	it("uses the local Vitest CLI and only the approved file", async () => {
		const root = await workspace();
		const vitestCli = path.join(root, "node_modules/vitest/dist/cli.js");
		await mkdir(path.dirname(vitestCli), { recursive: true });
		await writeFile(vitestCli, "", "utf8");
		const testCase = await createApprovedFile(
			root,
			"test/feature.test.ts",
			'import { test } from "vitest";\ntest("feature", () => {});\n',
		);
		const execute = vi.fn(async (_command: string) => ({ stdout: "passed", stderr: "", code: 0, killed: false }));
		const result = await runApprovedRegressionCase(root, testCase, execute);
		expect(result.runner).toBe("vitest");
		expect(execute).toHaveBeenCalledWith(
			process.execPath,
			[vitestCli, "--run", path.join("test", "feature.test.ts")],
			expect.objectContaining({ cwd: root }),
		);
	});

	it.each([
		[
			"tests/test_feature.py",
			"def test_feature():\n    assert True\n",
			"pytest",
			process.platform === "win32" ? "python" : "python3",
		],
		["feature/feature_test.go", "package feature\n", "go test", "go"],
	])("selects a bounded runner for %s", async (filePath, content, runner, command) => {
		const root = await workspace();
		const testCase = await createApprovedFile(root, filePath, content);
		const execute = vi.fn(async (_command: string) => ({ stdout: "passed", stderr: "", code: 0, killed: false }));
		const result = await runApprovedRegressionCase(root, testCase, execute);
		expect(result.runner).toBe(runner);
		expect(execute.mock.calls[0]?.[0]).toBe(command);
	});

	it("refuses to execute a file changed after approval", async () => {
		const root = await workspace();
		const filePath = "test/changed.test.ts";
		const testCase = await createApprovedFile(root, filePath, 'import test from "node:test";\n');
		await writeFile(path.join(root, filePath), 'import test from "node:test";\n// changed\n', "utf8");
		const execute = vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
		await expect(runApprovedRegressionCase(root, testCase, execute)).rejects.toThrow("批准后已被修改");
		expect(execute).not.toHaveBeenCalled();
	});

	it("selects the latest case or one unambiguous id prefix", () => {
		const first = approvedCase("test/first.test.ts", "first", {
			id: "abcdef-one",
			approvedAt: "2026-08-09T00:00:00.000Z",
		});
		const second = approvedCase("test/second.test.ts", "second", {
			id: "abcdef-two",
			approvedAt: "2026-08-09T00:00:01.000Z",
		});
		expect(selectApprovedRegressionCase([second, first])).toBe(second);
		expect(selectApprovedRegressionCase([second, first], "abcdef-one")).toBe(first);
		expect(selectApprovedRegressionCase([second, first], "abcdef")).toBeUndefined();
	});
});
