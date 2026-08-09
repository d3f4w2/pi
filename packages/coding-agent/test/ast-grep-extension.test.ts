import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { createAstGrepExtension } from "../src/extensions/ast-grep/index.ts";
import { AstGrepService } from "../src/extensions/ast-grep/search.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-ast-grep-"));
	tempDirectories.push(directory);
	return realpath(directory);
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ast_grep extension", () => {
	test("registers compact structural search and edit tools", () => {
		const tools: ToolDefinition[] = [];
		const service = { search: vi.fn() };
		const editService = { preview: vi.fn(), edit: vi.fn() };
		createAstGrepExtension(
			service,
			editService,
		)({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
		} as unknown as ExtensionAPI);

		expect(tools).toHaveLength(2);
		expect(tools[0]?.name).toBe("ast_grep");
		expect(tools[0]?.description).toContain("代码结构");
		expect(tools[0]?.description).not.toContain("修改");
		expect(tools[0]?.promptGuidelines?.join(" ")).toContain("grep");
		expect(tools[0]?.promptGuidelines?.join(" ")).toContain("不要调用 bash");
		expect(tools[0]?.promptGuidelines?.join(" ")).toContain("一次");
		expect(tools[0]?.parameters).toMatchObject({
			properties: {
				pattern: { minLength: 1 },
				language: { anyOf: expect.arrayContaining([expect.objectContaining({ const: "auto" })]) },
				max_results: { maximum: 1000 },
			},
		});
		expect(tools[1]).toMatchObject({
			name: "ast_edit",
			executionMode: "sequential",
			approval: { tier: "write" },
			parameters: {
				properties: {
					pattern: { minLength: 1 },
					replacement: { type: "string" },
					max_matches: { maximum: 1000 },
				},
			},
		});
	});
});

describe("ast-grep search service", () => {
	test("finds syntax nodes but ignores matching text in comments and strings", async () => {
		const project = await createTempDirectory();
		await mkdir(path.join(project, "src"), { recursive: true });
		await writeFile(
			path.join(project, "src", "index.ts"),
			[
				"console.log('first');",
				"// console.log('comment');",
				"const example = \"console.log('string')\";",
				"console.log('second', example);",
			].join("\n"),
			"utf8",
		);

		const result = await new AstGrepService().search(
			{ pattern: "console.log($$$ARGS)", language: "typescript", path: "src", maxResults: 10 },
			project,
		);

		expect(result.details.resultCount).toBe(2);
		expect(result.details.scannedFiles).toBe(1);
		expect(result.text).toContain("src/index.ts:1:1 console.log('first')");
		expect(result.text).toContain("src/index.ts:4:1 console.log('second', example)");
		expect(result.text).not.toContain("comment");
		expect(result.text).not.toContain("string')");
	});

	test("stops at the result limit and reports truncation", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "index.ts"), "print(1);\nprint(2);\nprint(3);\n", "utf8");

		const result = await new AstGrepService().search(
			{ pattern: "print($$$ARGS)", language: "typescript", maxResults: 2 },
			project,
		);

		expect(result.details.resultCount).toBe(2);
		expect(result.details.truncated).toBe(true);
		expect(result.text.split("\n")).toHaveLength(3);
		expect(result.text).toContain("结果已限制为 2 条");
	});

	test("searches JavaScript, TypeScript, and TSX in one automatic-language request", async () => {
		const project = await createTempDirectory();
		await mkdir(path.join(project, "packages"), { recursive: true });
		await writeFile(path.join(project, "packages", "first.js"), "console.log('js');\n", "utf8");
		await writeFile(path.join(project, "packages", "second.ts"), "console.log('ts');\n", "utf8");
		await writeFile(
			path.join(project, "packages", "third.tsx"),
			"export const View = () => <button onClick={() => console.log('tsx')}>ok</button>;\n",
			"utf8",
		);

		const result = await new AstGrepService().search(
			{ pattern: "console.log($$$ARGS)", language: "auto", path: "packages", maxResults: 10 },
			project,
		);

		expect(result.details.resultCount).toBe(3);
		expect(result.details.scannedFiles).toBe(3);
		expect(result.text).toContain("packages/first.js:1:1");
		expect(result.text).toContain("packages/second.ts:1:1");
		expect(result.text).toContain("packages/third.tsx:1:");
	});

	test("groups large result sets by file without repeating code snippets", async () => {
		const project = await createTempDirectory();
		await mkdir(path.join(project, "packages"), { recursive: true });
		await writeFile(
			path.join(project, "packages", "many.ts"),
			Array.from({ length: 25 }, (_, index) => `console.log(${index});`).join("\n"),
			"utf8",
		);

		const result = await new AstGrepService().search(
			{ pattern: "console.log($$$ARGS)", language: "auto", path: "packages", maxResults: 100 },
			project,
		);

		expect(result.details.resultCount).toBe(25);
		expect(result.text).toContain("找到 25 处，分布在 1 个文件");
		expect(result.text).toContain("packages/many.ts: 1:1, 2:1");
		expect(result.text).not.toContain("console.log(");
		expect(result.text.length).toBeLessThan(500);
	});

	test("rejects paths outside the current project", async () => {
		const project = await createTempDirectory();
		const outside = await createTempDirectory();

		await expect(
			new AstGrepService().search({ pattern: "console.log($A)", language: "typescript", path: outside }, project),
		).rejects.toThrow("当前项目");
	});
});
