import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkNativeFiles } from "../src/core/tools/native-file-search.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
	const root = path.join(tmpdir(), `pi-native-search-${process.pid}-${Date.now()}-${roots.length}`);
	roots.push(root);
	await mkdir(path.join(root, "nested"), { recursive: true });
	return root;
}

describe("walkNativeFiles", () => {
	it("honors ignore files while scanning directories concurrently", async () => {
		const root = await createRoot();
		await Promise.all([
			writeFile(path.join(root, ".gitignore"), "ignored.txt\n"),
			writeFile(path.join(root, "kept.txt"), "kept"),
			writeFile(path.join(root, "ignored.txt"), "ignored"),
			writeFile(path.join(root, "nested", "child.txt"), "child"),
		]);

		const entries = await walkNativeFiles(root, { pattern: "**/*.txt" });
		expect(entries.map((entry) => entry.relativePath)).toEqual(["kept.txt", "nested/child.txt"]);
	});

	it("stops at the requested result limit", async () => {
		const root = await createRoot();
		await Promise.all([
			writeFile(path.join(root, "a.txt"), "a"),
			writeFile(path.join(root, "b.txt"), "b"),
			writeFile(path.join(root, "c.txt"), "c"),
		]);

		const entries = await walkNativeFiles(root, { pattern: "*.txt", limit: 2 });
		expect(entries).toHaveLength(2);
	});

	it("honors an already-aborted signal", async () => {
		const root = await createRoot();
		const controller = new AbortController();
		controller.abort();

		await expect(walkNativeFiles(root, { signal: controller.signal })).rejects.toThrow("Operation aborted");
	});
});
