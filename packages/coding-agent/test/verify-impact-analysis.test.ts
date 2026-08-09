import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { findJavaScriptRelatedTests, findPythonRelatedTests } from "../src/extensions/verify/impact.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-verify-impact-"));
	tempDirectories.push(directory);
	return realpath(directory);
}

async function writeProjectFile(root: string, relativePath: string, content: string): Promise<void> {
	const filePath = path.join(root, relativePath);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("verify impact analysis", () => {
	test("finds a JavaScript test through transitive imports", async () => {
		const project = await createTempDirectory();
		await writeProjectFile(project, "src/shared/parser.ts", "export const parse = () => 1;\n");
		await writeProjectFile(
			project,
			"src/user-service.ts",
			'import { parse } from "./shared/parser";\nexport const user = parse();\n',
		);
		await writeProjectFile(
			project,
			"test/api/user-api.test.ts",
			'import { user } from "../../src/user-service";\ntest("user", () => user);\n',
		);
		await writeProjectFile(project, "test/unrelated.test.ts", 'test("other", () => {});\n');

		const result = await findJavaScriptRelatedTests(project, path.join(project, "src/shared/parser.ts"));

		expect(result.files).toEqual(["test/api/user-api.test.ts"]);
		expect(result.strategy).toBe("dependency-graph");
		expect(result.truncated).toBe(false);
	});

	test("resolves tsconfig path aliases", async () => {
		const project = await createTempDirectory();
		await writeProjectFile(
			project,
			"tsconfig.json",
			JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
		);
		await writeProjectFile(project, "src/shared/parser.ts", "export const parse = () => 1;\n");
		await writeProjectFile(
			project,
			"src/user-service.ts",
			'import { parse } from "@/shared/parser";\nexport { parse };\n',
		);
		await writeProjectFile(project, "test/user.test.ts", 'import "@/user-service";\ntest("user", () => {});\n');

		const result = await findJavaScriptRelatedTests(project, path.join(project, "src/shared/parser.ts"));

		expect(result.files).toEqual(["test/user.test.ts"]);
		expect(result.strategy).toBe("dependency-graph");
	});

	test("finds a Python test through transitive imports", async () => {
		const project = await createTempDirectory();
		await writeProjectFile(project, "src/app/parser.py", "def parse():\n    return 1\n");
		await writeProjectFile(project, "src/app/service.py", "from .parser import parse\n");
		await writeProjectFile(
			project,
			"tests/test_api.py",
			"from app.service import parse\n\ndef test_api():\n    assert parse() == 1\n",
		);
		await writeProjectFile(project, "tests/test_other.py", "def test_other():\n    assert True\n");

		const result = await findPythonRelatedTests(project, path.join(project, "src/app/parser.py"));

		expect(result.files).toEqual(["tests/test_api.py"]);
		expect(result.strategy).toBe("dependency-graph");
	});

	test("falls back to a filename match when the graph file limit is exceeded", async () => {
		const project = await createTempDirectory();
		await writeProjectFile(project, "src/user.ts", "export const user = 1;\n");
		await writeProjectFile(project, "test/user.test.ts", 'test("user", () => {});\n');
		await writeProjectFile(project, "src/extra.ts", "export const extra = 1;\n");

		const result = await findJavaScriptRelatedTests(project, path.join(project, "src/user.ts"), { maxFiles: 2 });

		expect(result.files).toEqual(["test/user.test.ts"]);
		expect(result.strategy).toBe("filename-fallback");
		expect(result.truncated).toBe(true);
		expect(result.note).toContain("2");
	});
});
