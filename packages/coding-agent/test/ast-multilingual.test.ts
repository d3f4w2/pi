import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AstEditService } from "../src/extensions/ast-grep/edit.ts";
import { AstGrepService } from "../src/extensions/ast-grep/search.ts";
import type { AstEditRequest, AstGrepExplicitLanguage } from "../src/extensions/ast-grep/types.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-ast-multilingual-"));
	tempDirectories.push(directory);
	return realpath(directory);
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("multilingual ast search", () => {
	test.each([
		{
			language: "python" as const,
			file: "sample.py",
			source: "def run(value):\n    print(value)\n",
			pattern: "print($ARG)",
			capture: "value",
		},
		{
			language: "go" as const,
			file: "sample.go",
			source: 'package main\nfunc main() { println("go") }\n',
			pattern: "println($ARG)",
			capture: '"go"',
		},
		{
			language: "rust" as const,
			file: "sample.rs",
			source: 'fn main() { println!("rust"); }\n',
			pattern: "println!($ARG)",
			capture: '"rust"',
		},
	])("finds real $language syntax nodes and captures", async ({ language, file, source, pattern, capture }) => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, file), source, "utf8");

		const result = await new AstGrepService().search({ pattern, language, maxResults: 10 }, project);

		expect(result.details.resultCount).toBe(1);
		expect(result.details.matches[0]).toMatchObject({
			file,
			range: { start: { line: expect.any(Number), column: expect.any(Number), index: expect.any(Number) } },
		});
		expect(result.details.matches[0]?.captures.ARG?.[0]?.text).toBe(capture);
	});

	test("auto-detects JSON, YAML, and Markdown and reports ranges", async () => {
		const project = await createTempDirectory();
		await mkdir(path.join(project, "data"));
		await writeFile(path.join(project, "data", "value.json"), '{"name":"json"}\n', "utf8");
		await writeFile(path.join(project, "data", "value.yaml"), "name: yaml\n", "utf8");
		await writeFile(path.join(project, "data", "README.md"), "# Local plane\n", "utf8");

		const json = await new AstGrepService().search(
			{ pattern: '{"name": $VALUE}', language: "auto", path: "data/value.json", maxResults: 10 },
			project,
		);
		const yaml = await new AstGrepService().search(
			{ pattern: "name: $VALUE", language: "auto", path: "data/value.yaml", maxResults: 10 },
			project,
		);
		const markdown = await new AstGrepService().search(
			{ pattern: "# $TITLE", language: "auto", path: "data/README.md", maxResults: 10 },
			project,
		);

		expect(json.details.matches[0]?.captures.VALUE?.[0]?.text).toBe('"json"');
		expect(yaml.details.matches[0]?.captures.VALUE?.[0]?.text).toBe("yaml");
		expect(markdown.details.matches[0]).toMatchObject({
			file: "data/README.md",
			range: { start: { line: 1, column: 1, index: 0 } },
			captures: { TITLE: [{ text: "Local plane", range: expect.any(Object) }] },
		});
	});

	test("supports an explicit language override and rejects unsupported auto-detection once", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "script.txt"), "print('override')\n", "utf8");
		await writeFile(path.join(project, "config.toml"), "value = 1\n", "utf8");

		const overridden = await new AstGrepService().search(
			{ pattern: "print($ARG)", language: "python", path: "script.txt", maxResults: 10 },
			project,
		);

		expect(overridden.details.resultCount).toBe(1);
		await expect(
			new AstGrepService().search(
				{ pattern: "$NODE", language: "auto", path: "config.toml", maxResults: 10 },
				project,
			),
		).rejects.toThrow("不支持文件 config.toml");
	});
});

describe("multilingual ast edit", () => {
	test.each([
		{
			language: "python" as const,
			file: "sample.py",
			source: "def run(value):\n    print(value)\n",
			pattern: "print($ARG)",
			replacement: "logger.info($ARG)",
			expected: "def run(value):\n    logger.info(value)\n",
		},
		{
			language: "go" as const,
			file: "sample.go",
			source: 'package main\nfunc main() { println("go") }\n',
			pattern: "println($ARG)",
			replacement: "log.Print($ARG)",
			expected: 'package main\nfunc main() { log.Print("go") }\n',
		},
		{
			language: "rust" as const,
			file: "sample.rs",
			source: 'fn main() { println!("rust"); }\n',
			pattern: "println!($ARG)",
			replacement: "eprintln!($ARG)",
			expected: 'fn main() { eprintln!("rust"); }\n',
		},
	])("previews then changes real $language syntax nodes", async (fixture) => {
		const project = await createTempDirectory();
		const filePath = path.join(project, fixture.file);
		await writeFile(filePath, fixture.source, "utf8");
		const request: AstEditRequest = {
			pattern: fixture.pattern,
			replacement: fixture.replacement,
			language: fixture.language,
		};
		const service = new AstEditService();

		const preview = await service.preview(request, project);
		expect(preview.details).toMatchObject({ changedFileCount: 1, matchCount: 1 });
		expect(await readFile(filePath, "utf8")).toBe(fixture.source);
		await service.edit(request, project);
		expect(await readFile(filePath, "utf8")).toBe(fixture.expected);
	});

	test.each([
		{
			language: "json" as const,
			file: "value.json",
			source: '{"name":"valid"}\n',
			pattern: '{"name": $VALUE}',
			replacement: '{"name":}',
		},
		{
			language: "yaml" as const,
			file: "value.yaml",
			source: "name: valid\n",
			pattern: "name: $VALUE",
			replacement: "name: [",
		},
	])("rejects edits that would make $language invalid", async (fixture) => {
		const project = await createTempDirectory();
		const filePath = path.join(project, fixture.file);
		await writeFile(filePath, fixture.source, "utf8");

		await expect(
			new AstEditService().edit(
				{
					pattern: fixture.pattern,
					replacement: fixture.replacement,
					language: fixture.language,
				},
				project,
			),
		).rejects.toThrow(`无效 ${fixture.language.toUpperCase()}`);
		expect(await readFile(filePath, "utf8")).toBe(fixture.source);
	});

	test("uses the preview revision when applying and refuses intervening changes", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "sample.py");
		const request: AstEditRequest = {
			pattern: "print($ARG)",
			replacement: "logger.info($ARG)",
			language: "python",
		};
		await writeFile(filePath, "print('preview')\n", "utf8");
		const service = new AstEditService();
		await service.preview(request, project);
		await writeFile(filePath, "print('changed')\n", "utf8");

		await expect(service.edit(request, project)).rejects.toThrow("在预览后发生变化");
		expect(await readFile(filePath, "utf8")).toBe("print('changed')\n");
	});

	test("rolls back every committed file when a later file write fails", async () => {
		const project = await createTempDirectory();
		const first = path.join(project, "first.py");
		const second = path.join(project, "second.py");
		await writeFile(first, "print('first')\n", "utf8");
		await writeFile(second, "print('second')\n", "utf8");
		let writes = 0;
		const service = new AstEditService({
			replaceFile: async (filePath, content) => {
				writes++;
				if (writes === 2) throw new Error("injected write failure");
				await writeFile(filePath, content, "utf8");
			},
		});

		await expect(
			service.edit(
				{
					pattern: "print($ARG)",
					replacement: "logger.info($ARG)",
					language: "python",
				},
				project,
			),
		).rejects.toThrow("已回滚全部变更");
		expect(await readFile(first, "utf8")).toBe("print('first')\n");
		expect(await readFile(second, "utf8")).toBe("print('second')\n");
	});

	test("previews and edits Markdown headings", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "README.md");
		await writeFile(filePath, "# Before\n\nBody\n", "utf8");
		const request = {
			pattern: "# $TITLE",
			replacement: "## $TITLE",
			language: "markdown" as AstGrepExplicitLanguage,
		};
		const service = new AstEditService();

		await service.preview(request, project);
		expect(await readFile(filePath, "utf8")).toBe("# Before\n\nBody\n");
		await service.edit(request, project);
		expect(await readFile(filePath, "utf8")).toBe("## Before\n\nBody\n");
	});
});
