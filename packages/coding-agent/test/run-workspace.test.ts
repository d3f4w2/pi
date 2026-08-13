import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareWorkspaceSnapshots, getGitWorkspaceRoot, takeWorkspaceSnapshot } from "../src/cli/run-workspace.ts";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function createRepository(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pigo-run-workspace-"));
	temporaryDirectories.push(root);
	git(root, "init", "--quiet");
	git(root, "config", "user.email", "pigo@example.invalid");
	git(root, "config", "user.name", "Pigo Test");
	await mkdir(path.join(root, "src"));
	await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 1;\n", "utf8");
	await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "initial");
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("verifiable run workspace evidence", () => {
	it("finds the Git root from a nested working directory", async () => {
		const root = await createRepository();
		const nested = path.join(root, "src");

		expect(await getGitWorkspaceRoot(nested)).toBe(await getGitWorkspaceRoot(root));
	});

	it("does not attribute unchanged pre-existing dirty files to the run", async () => {
		const root = await createRepository();
		await writeFile(path.join(root, "README.md"), "user change\n", "utf8");
		const before = await takeWorkspaceSnapshot(root);
		const after = await takeWorkspaceSnapshot(root);

		const result = compareWorkspaceSnapshots(before, after, ["src"]);
		expect(result.changed).toEqual([]);
		expect(result.scopeViolations).toEqual([]);
		expect(result.headChanged).toBe(false);
	});

	it("attributes a second modification to an already-dirty file", async () => {
		const root = await createRepository();
		await writeFile(path.join(root, "README.md"), "user change\n", "utf8");
		const before = await takeWorkspaceSnapshot(root);
		await writeFile(path.join(root, "README.md"), "agent change\n", "utf8");
		const after = await takeWorkspaceSnapshot(root);

		const result = compareWorkspaceSnapshots(before, after, ["src"]);
		expect(result.changed).toEqual([
			expect.objectContaining({
				path: "README.md",
				before: expect.stringMatching(/^dirty:/),
				after: expect.stringMatching(/^dirty:/),
			}),
		]);
		expect(result.scopeViolations).toEqual(["README.md"]);
	});

	it("detects tracked edits, untracked files, deletions, and index-only changes", async () => {
		const root = await createRepository();
		await writeFile(path.join(root, "README.md"), "user change\n", "utf8");
		const before = await takeWorkspaceSnapshot(root);

		await writeFile(path.join(root, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
		await writeFile(path.join(root, "src", "new.ts"), "export {};\n", "utf8");
		await rm(path.join(root, "README.md"));
		git(root, "add", "src/tracked.ts");
		const after = await takeWorkspaceSnapshot(root);

		const result = compareWorkspaceSnapshots(before, after, ["."]);
		expect(result.changed.map((entry) => entry.path)).toEqual(["README.md", "src/new.ts", "src/tracked.ts"]);
		expect(result.scopeViolations).toEqual([]);
	});

	it("does not report a clean file that is modified and restored", async () => {
		const root = await createRepository();
		const before = await takeWorkspaceSnapshot(root);
		await writeFile(path.join(root, "src", "tracked.ts"), "temporary\n", "utf8");
		git(root, "checkout", "--", "src/tracked.ts");
		const after = await takeWorkspaceSnapshot(root);

		expect(compareWorkspaceSnapshots(before, after, ["."]).changed).toEqual([]);
	});

	it("treats a HEAD change as noncompliant evidence", async () => {
		const root = await createRepository();
		const before = await takeWorkspaceSnapshot(root);
		await writeFile(path.join(root, "README.md"), "committed by run\n", "utf8");
		git(root, "add", "README.md");
		git(root, "commit", "--quiet", "-m", "unexpected commit");
		const after = await takeWorkspaceSnapshot(root);

		const result = compareWorkspaceSnapshots(before, after, ["."]);
		expect(result.headChanged).toBe(true);
		expect(result.headBefore).not.toBe(result.headAfter);
	});

	it("rejects directories outside a Git working tree", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pigo-run-no-git-"));
		temporaryDirectories.push(directory);

		await expect(getGitWorkspaceRoot(directory)).rejects.toThrow(/Git/);
	});
});
