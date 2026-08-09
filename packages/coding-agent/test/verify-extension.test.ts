import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { createVerifyExtension } from "../src/extensions/verify/index.ts";
import { VerifyService } from "../src/extensions/verify/service.ts";
import type { VerifyCommandRunner } from "../src/extensions/verify/types.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(prefix = "pi-verify-"): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), prefix));
	tempDirectories.push(directory);
	return realpath(directory);
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function passingRunner(): VerifyCommandRunner {
	return vi.fn(async () => ({ kind: "exited" as const, code: 0, output: "ok", outputTruncated: false }));
}

describe("verify extension", () => {
	test("registers one compact Chinese verification tool", () => {
		const tools: ToolDefinition[] = [];
		const service = { verify: vi.fn() };
		createVerifyExtension(service)({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
		} as unknown as ExtensionAPI);

		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("verify");
		expect(tools[0]?.description).toContain("类型检查、相关测试和 lint");
		expect(tools[0]?.promptGuidelines?.join(" ")).toContain("不要通过 bash");
		expect(tools[0]?.promptGuidelines?.join(" ")).toContain("检查刚才的修改");
		expect(tools[0]?.promptGuidelines?.join(" ")).toContain("明确要求运行程序");
		expect(tools[0]?.parameters).toMatchObject({
			properties: {
				operation: { anyOf: expect.arrayContaining([expect.objectContaining({ const: "auto" })]) },
				timeout: { minimum: 5, maximum: 300 },
			},
		});
	});
});

describe("verify service", () => {
	test("recognizes a standalone Python file without project markers", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "example.py"), "print('Hello, world!')\n", "utf8");
		const runner = passingRunner();

		const result = await new VerifyService({ runner }).verify({ operation: "auto", path: "example.py" }, project);

		expect(runner).toHaveBeenCalledTimes(2);
		expect(runner).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				label: "Python 语法检查",
				command: "python",
				args: expect.arrayContaining(["-c", "example.py"]),
				cwd: project,
			}),
			expect.any(AbortSignal),
			60_000,
		);
		expect(runner).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ command: "basedpyright", args: ["example.py"], cwd: project }),
			expect.any(AbortSignal),
			60_000,
		);
		expect(result.details.language).toBe("python");
		expect(result.details.passed).toBe(true);
		expect(result.text).toContain("Python 语法检查");
	});

	test("stops before type checking when standalone Python syntax is invalid", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "broken.py"), "def broken(:\n", "utf8");
		const runner: VerifyCommandRunner = vi.fn(async () => ({
			kind: "exited" as const,
			code: 1,
			output: "broken.py:1:12 SyntaxError: invalid syntax",
			outputTruncated: false,
		}));

		const result = await new VerifyService({ runner }).verify({ operation: "auto", path: "broken.py" }, project);

		expect(runner).toHaveBeenCalledOnce();
		expect(result.details.checks.map((check) => check.label)).toEqual(["Python 语法检查"]);
		expect(result.details.passed).toBe(false);
		expect(result.text).toContain("SyntaxError");
	});

	test("auto-checks TypeScript and runs only the related test", async () => {
		const project = await createTempDirectory();
		await mkdir(path.join(project, "src"), { recursive: true });
		await mkdir(path.join(project, "test"), { recursive: true });
		await writeFile(
			path.join(project, "package.json"),
			JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest --run" } }),
			"utf8",
		);
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		await writeFile(path.join(project, "src", "user.ts"), "export const user = 1;\n", "utf8");
		await writeFile(path.join(project, "test", "user.test.ts"), "test('user', () => {});\n", "utf8");
		const runner = passingRunner();

		const result = await new VerifyService({ runner }).verify({ operation: "auto", path: "src/user.ts" }, project);

		expect(runner).toHaveBeenCalledTimes(2);
		expect(runner).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ command: "npm", args: ["run", "typecheck"], cwd: project }),
			expect.any(AbortSignal),
			60_000,
		);
		expect(runner).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ command: "npm", args: ["run", "test", "--", "test/user.test.ts"] }),
			expect.any(AbortSignal),
			60_000,
		);
		expect(result.details.passed).toBe(true);
		expect(result.details.checks).toHaveLength(2);
		expect(result.text).toContain("2 项验证全部通过");
	});

	test("auto mode does not run the full test suite when no related test is found", async () => {
		const project = await createTempDirectory();
		await mkdir(path.join(project, "src"), { recursive: true });
		await writeFile(
			path.join(project, "package.json"),
			JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest --run" } }),
			"utf8",
		);
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		await writeFile(path.join(project, "src", "orphan.ts"), "export const value = 1;\n", "utf8");
		const runner = passingRunner();

		const result = await new VerifyService({ runner }).verify({ operation: "auto", path: "src/orphan.ts" }, project);

		expect(runner).toHaveBeenCalledOnce();
		expect(result.text).toContain("没有找到可安全定位的相关测试");
		expect(result.text).toContain("operation=test");
	});

	test("falls back from basedpyright to pyright", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "pyproject.toml"), "[project]\nname='demo'\n", "utf8");
		await writeFile(path.join(project, "main.py"), "value = 1\n", "utf8");
		const runner: VerifyCommandRunner = vi.fn(async (command) =>
			command.command === "basedpyright"
				? { kind: "not_found" as const, output: "", outputTruncated: false }
				: { kind: "exited" as const, code: 0, output: "0 errors", outputTruncated: false },
		);

		const result = await new VerifyService({ runner }).verify({ operation: "typecheck", path: "main.py" }, project);

		expect(runner).toHaveBeenCalledTimes(2);
		expect(runner).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ command: "pyright", args: ["main.py"] }),
			expect.any(AbortSignal),
			60_000,
		);
		expect(result.details.passed).toBe(true);
	});

	test("continues to related tests when an optional type checker is unavailable", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "pyproject.toml"), "[project]\nname='demo'\n", "utf8");
		await writeFile(path.join(project, "user.py"), "value = 1\n", "utf8");
		await writeFile(path.join(project, "test_user.py"), "def test_user():\n    assert True\n", "utf8");
		const runner: VerifyCommandRunner = vi.fn(async (command) =>
			command.command === "basedpyright" || command.command === "pyright"
				? { kind: "not_found" as const, output: "", outputTruncated: false }
				: { kind: "exited" as const, code: 0, output: "1 passed", outputTruncated: false },
		);

		const result = await new VerifyService({ runner }).verify({ operation: "auto", path: "user.py" }, project);

		expect(runner).toHaveBeenCalledTimes(3);
		expect(result.details.checks.map((check) => check.status)).toEqual(["unavailable", "passed"]);
		expect(result.text).toContain("pip install basedpyright");
		expect(result.text).toContain("[通过] 相关测试");
	});

	test("runs Go tests for only the target package", async () => {
		const project = await createTempDirectory();
		await mkdir(path.join(project, "internal", "user"), { recursive: true });
		await writeFile(path.join(project, "go.mod"), "module example.com/demo\n", "utf8");
		await writeFile(path.join(project, "internal", "user", "user.go"), "package user\n", "utf8");
		const runner = passingRunner();

		await new VerifyService({ runner }).verify({ operation: "test", path: "internal/user/user.go" }, project);

		expect(runner).toHaveBeenCalledWith(
			expect.objectContaining({ command: "go", args: ["test", "./internal/user"], cwd: project }),
			expect.any(AbortSignal),
			60_000,
		);
	});

	test("returns compact failure details and saves the captured log", async () => {
		const project = await createTempDirectory();
		const logDirectory = await createTempDirectory("pi-verify-logs-");
		await writeFile(
			path.join(project, "package.json"),
			JSON.stringify({ scripts: { test: "vitest --run" } }),
			"utf8",
		);
		await writeFile(path.join(project, "user.test.ts"), "test('user', () => {});\n", "utf8");
		const output = [
			...Array.from({ length: 100 }, (_, index) => `progress ${index}`),
			"user.test.ts:3:5 AssertionError: expected 200 but received 401",
		].join("\n");
		const runner: VerifyCommandRunner = vi.fn(async () => ({
			kind: "exited" as const,
			code: 1,
			output,
			outputTruncated: false,
		}));

		const result = await new VerifyService({ runner, logDirectory }).verify(
			{ operation: "test", path: "user.test.ts" },
			project,
		);

		expect(result.details.passed).toBe(false);
		expect(result.text).toContain("user.test.ts:3:5");
		expect(result.text).not.toContain("progress 50");
		expect(result.details.logPath).toBeDefined();
		expect(await readFile(result.details.logPath!, "utf8")).toContain("progress 50");
	});

	test("rejects paths outside the current project", async () => {
		const project = await createTempDirectory();
		const outside = await createTempDirectory();

		await expect(
			new VerifyService({ runner: passingRunner() }).verify({ operation: "auto", path: outside }, project),
		).rejects.toThrow("当前项目");
	});
});
