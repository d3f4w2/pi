import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition, type EditOperations } from "../src/core/tools/edit.ts";
import { createFileRevision, createLineAnchor, formatAnchoredText } from "../src/core/tools/file-anchors.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-reliable-edit-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function textFrom(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("file anchors", () => {
	it("normalizes BOM and line endings for stable revisions", () => {
		expect(createFileRevision("\uFEFFalpha\r\nbeta\r\n")).toBe(createFileRevision("alpha\nbeta\n"));
	});

	it("formats original line numbers and compact content anchors", () => {
		const output = formatAnchoredText("beta\ngamma", 2, "revision123");
		expect(output).toBe(`¶#revision123\n${createLineAnchor(2, "beta")}|beta\n${createLineAnchor(3, "gamma")}|gamma`);
	});
});

describe("anchored read", () => {
	it("returns a full-file revision and preserves partial-read line numbers", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "sample.ts"), "alpha\nbeta\ngamma\n", "utf8");

		const result = await createReadToolDefinition(dir).execute(
			"read-1",
			{ path: "sample.ts", offset: 2, limit: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const output = textFrom(result);
		expect(output).toContain(`¶sample.ts#${createFileRevision("alpha\nbeta\ngamma\n")}`);
		expect(output).toContain(`${createLineAnchor(2, "beta")}|beta`);
		expect(output).not.toContain(`${createLineAnchor(1, "alpha")}|alpha`);
		expect(result.details).toMatchObject({
			anchored: true,
			fileHash: createFileRevision("alpha\nbeta\ngamma\n"),
		});
	});

	it("does not add edit anchors to context resources", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "AGENTS.md"), "Follow the project rules.\n", "utf8");

		const result = await createReadToolDefinition(dir).execute(
			"read-2",
			{ path: "AGENTS.md" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(textFrom(result)).toBe("Follow the project rules.\n");
		expect(result.details).toBeUndefined();
	});
});

describe("anchored edit", () => {
	it("replaces an anchored range and preserves BOM plus CRLF", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "sample.ts");
		const original = "\uFEFFalpha\r\nbeta\r\ngamma\r\n";
		await writeFile(filePath, original, "utf8");

		await createEditToolDefinition(dir).execute(
			"edit-1",
			{
				path: "sample.ts",
				baseHash: createFileRevision(original),
				edits: [
					{
						startAnchor: createLineAnchor(2, "beta"),
						newText: "BETA",
					},
				],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(await readFile(filePath, "utf8")).toBe("\uFEFFalpha\r\nBETA\r\ngamma\r\n");
		expect((await readdir(dir)).filter((name) => name.includes(".pi-edit-"))).toEqual([]);
	});

	it("relocates a moved anchor only when it is unique", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "sample.ts");
		await writeFile(filePath, "zero\nalpha\nbeta\ngamma\n", "utf8");

		await createEditToolDefinition(dir).execute(
			"edit-2",
			{
				path: "sample.ts",
				edits: [{ startAnchor: createLineAnchor(2, "beta"), newText: "BETA" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(filePath, "utf8")).toBe("zero\nalpha\nBETA\ngamma\n");
	});

	it("rejects stale revisions before writing", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "sample.ts");
		const original = "alpha\nbeta\n";
		await writeFile(filePath, "changed\nbeta\n", "utf8");

		await expect(
			createEditToolDefinition(dir).execute(
				"edit-3",
				{
					path: "sample.ts",
					baseHash: createFileRevision(original),
					edits: [{ startAnchor: createLineAnchor(2, "beta"), newText: "BETA" }],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/changed since it was read/i);
		expect(await readFile(filePath, "utf8")).toBe("changed\nbeta\n");
	});

	it("rejects ambiguous relocated anchors without writing", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "sample.ts");
		await writeFile(filePath, "beta\nalpha\nbeta\n", "utf8");

		await expect(
			createEditToolDefinition(dir).execute(
				"edit-4",
				{
					path: "sample.ts",
					edits: [{ startAnchor: createLineAnchor(99, "beta"), newText: "BETA" }],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/ambiguous/i);
		expect(await readFile(filePath, "utf8")).toBe("beta\nalpha\nbeta\n");
	});

	it("validates every range before invoking the write backend", async () => {
		let writes = 0;
		const content = Buffer.from("alpha\nbeta\ngamma\n");
		const operations: EditOperations = {
			access: async () => {},
			readFile: async () => content,
			writeFile: async () => {
				writes++;
			},
			replaceFile: async () => {
				writes++;
			},
		};

		await expect(
			createEditToolDefinition(".", { operations }).execute(
				"edit-5",
				{
					path: "sample.ts",
					edits: [
						{
							startAnchor: createLineAnchor(1, "alpha"),
							endAnchor: createLineAnchor(2, "beta"),
							newText: "first",
						},
						{
							startAnchor: createLineAnchor(2, "beta"),
							endAnchor: createLineAnchor(3, "gamma"),
							newText: "second",
						},
					],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/overlap/i);
		expect(writes).toBe(0);
	});
});
