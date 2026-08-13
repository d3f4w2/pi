import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CiReceiptFile,
	discoverCiReceiptFiles,
	MAX_CI_RECEIPT_BYTES,
	selectLatestCiReceiptFile,
} from "../src/cli/ci-files.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pigo-ci-files-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("CI receipt discovery", () => {
	it("selects the newest receipt with a deterministic path tie-break", () => {
		const files: CiReceiptFile[] = [
			{ absolutePath: "/runs/a.json", displayPath: "a.json", modifiedMs: 10 },
			{ absolutePath: "/runs/c.json", displayPath: "c.json", modifiedMs: 20 },
			{ absolutePath: "/runs/b.json", displayPath: "b.json", modifiedMs: 20 },
		];

		expect(selectLatestCiReceiptFile(files).displayPath).toBe("c.json");
	});

	it("recursively sorts JSON receipts and removes duplicate inputs", async () => {
		const directory = await temporaryDirectory();
		await mkdir(path.join(directory, "nested"));
		await writeFile(path.join(directory, "z.json"), "{}");
		await writeFile(path.join(directory, "nested", "a.JSON"), "{}");
		await writeFile(path.join(directory, "notes.txt"), "ignored");

		const files = await discoverCiReceiptFiles([directory, path.join(directory, "z.json")], directory);

		expect(files.map(({ displayPath }) => displayPath)).toEqual(["nested/a.JSON", "z.json"]);
	});

	it("rejects empty directories and oversized receipts", async () => {
		const directory = await temporaryDirectory();

		await expect(discoverCiReceiptFiles([directory], directory)).rejects.toThrow(/No receipt JSON/);
		const oversized = path.join(directory, "oversized.json");
		await writeFile(oversized, Buffer.alloc(MAX_CI_RECEIPT_BYTES + 1));
		await expect(discoverCiReceiptFiles([oversized], directory)).rejects.toThrow(/exceeds/);
	});
});
