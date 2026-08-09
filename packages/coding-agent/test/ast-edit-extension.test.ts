import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AstEditService } from "../src/extensions/ast-grep/edit.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-ast-edit-"));
	tempDirectories.push(directory);
	return realpath(directory);
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ast edit service", () => {
	test("previews and applies structural replacements while preserving captured arguments", async () => {
		const project = await createTempDirectory();
		await mkdir(path.join(project, "src"), { recursive: true });
		await writeFile(path.join(project, "src", "first.ts"), "console.log(alpha, beta + 1);\n", "utf8");
		await writeFile(path.join(project, "src", "second.ts"), "console.log('second');\n", "utf8");

		const service = new AstEditService();
		const request = {
			pattern: "console.log($$$ARGS)",
			replacement: "logger.info($$$ARGS)",
			language: "typescript" as const,
			path: "src",
		};
		const preview = await service.preview(request, project);

		expect(preview.details).toMatchObject({
			changedFileCount: 2,
			changedFiles: ["src/first.ts", "src/second.ts"],
			matchCount: 2,
			additions: 2,
			deletions: 2,
		});
		expect(preview.details.diffs.map((diff) => diff.path)).toEqual(["src/first.ts", "src/second.ts"]);
		expect(await readFile(path.join(project, "src", "first.ts"), "utf8")).toContain("console.log");

		const result = await service.edit(request, project);
		expect(result.text).toContain("2 个文件");
		expect(await readFile(path.join(project, "src", "first.ts"), "utf8")).toBe("logger.info(alpha, beta + 1);\n");
		expect(await readFile(path.join(project, "src", "second.ts"), "utf8")).toBe("logger.info('second');\n");
	});

	test("does not change comments or strings that merely contain matching text", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "index.ts");
		await writeFile(
			filePath,
			"// console.log('comment')\nconst text = \"console.log('string')\";\nconsole.log(text);\n",
			"utf8",
		);

		await new AstEditService().edit(
			{
				pattern: "console.log($$$ARGS)",
				replacement: "logger.info($$$ARGS)",
				language: "typescript",
			},
			project,
		);

		const content = await readFile(filePath, "utf8");
		expect(content).toContain("// console.log('comment')");
		expect(content).toContain("\"console.log('string')\"");
		expect(content).toContain("logger.info(text)");
	});

	test("fails closed when the match limit is exceeded", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "index.ts");
		const original = "console.log(1);\nconsole.log(2);\n";
		await writeFile(filePath, original, "utf8");

		await expect(
			new AstEditService().edit(
				{
					pattern: "console.log($$$ARGS)",
					replacement: "logger.info($$$ARGS)",
					language: "typescript",
					maxMatches: 1,
				},
				project,
			),
		).rejects.toThrow("超过 1 处");
		expect(await readFile(filePath, "utf8")).toBe(original);
	});

	test("reports no matches without writing", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "index.ts");
		await writeFile(filePath, "const value = 1;\n", "utf8");

		await expect(
			new AstEditService().edit(
				{
					pattern: "console.log($$$ARGS)",
					replacement: "logger.info($$$ARGS)",
					language: "typescript",
				},
				project,
			),
		).rejects.toThrow("没有找到");
		expect(await readFile(filePath, "utf8")).toBe("const value = 1;\n");
	});

	test("rejects a stale prepared plan before writing any file", async () => {
		const project = await createTempDirectory();
		const firstPath = path.join(project, "first.ts");
		const secondPath = path.join(project, "second.ts");
		await writeFile(firstPath, "console.log('first');\n", "utf8");
		await writeFile(secondPath, "console.log('second');\n", "utf8");
		const service = new AstEditService();
		const plan = await service.preparePlan(
			{
				pattern: "console.log($$$ARGS)",
				replacement: "logger.info($$$ARGS)",
				language: "typescript",
			},
			project,
		);
		await writeFile(secondPath, "changed();\n", "utf8");

		await expect(service.applyPlan(plan)).rejects.toThrow("预览后发生变化");
		expect(await readFile(firstPath, "utf8")).toBe("console.log('first');\n");
		expect(await readFile(secondPath, "utf8")).toBe("changed();\n");
	});
});
