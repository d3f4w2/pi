import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { createGitExtension } from "../src/extensions/git/index.ts";
import { GitService, parseGitStatus } from "../src/extensions/git/service.ts";

const tempDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

async function createRepository(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-git-tool-"));
	tempDirectories.push(directory);
	git(directory, "init");
	git(directory, "config", "user.name", "Pi Test");
	git(directory, "config", "user.email", "pi@example.com");
	await writeFile(path.join(directory, "README.md"), "before\n", "utf8");
	git(directory, "add", "README.md");
	git(directory, "commit", "-m", "initial");
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("git status parser", () => {
	test("parses branch, staged, worktree, rename, and untracked records", () => {
		const output = [
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -1",
			"1 M. N... 100644 100644 100644 a a staged.ts",
			"1 .M N... 100644 100644 100644 a a work tree.ts",
			"2 R. N... 100644 100644 100644 a a R100 renamed.ts",
			"old.ts",
			"? new.ts",
			"",
		].join("\0");

		const result = parseGitStatus(output, "/repo");
		expect(result).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1 });
		expect(result.files).toEqual([
			expect.objectContaining({ path: "staged.ts", staged: true, unstaged: false }),
			expect.objectContaining({ path: "work tree.ts", staged: false, unstaged: true }),
			expect.objectContaining({ path: "renamed.ts", originalPath: "old.ts", staged: true }),
			expect.objectContaining({ path: "new.ts", untracked: true }),
		]);
	});

	test("marks status as truncated only when changed files exceed the limit", () => {
		const output = ["# branch.head main", "? one.ts", "? two.ts", ""].join("\0");
		expect(parseGitStatus(output, "/repo", 2).truncated).toBe(false);
		expect(parseGitStatus(output, "/repo", 1)).toMatchObject({ truncated: true, files: [{ path: "one.ts" }] });
	});
});

describe("git service", () => {
	test("returns a compact overview and a reusable file diff", async () => {
		const repository = await createRepository();
		await writeFile(path.join(repository, "README.md"), "after\n", "utf8");
		await writeFile(path.join(repository, "new.ts"), "export {};\n", "utf8");
		const service = new GitService();

		const overview = await service.overview(repository);
		expect(overview.overview.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "README.md", unstaged: true }),
				expect.objectContaining({ path: "new.ts", untracked: true }),
			]),
		);
		expect(overview.text.length).toBeLessThan(500);

		const result = await service.diff(repository, "README.md", "all");
		expect(result.diff).toMatchObject({ path: "README.md", additions: 1, deletions: 1 });
		expect(result.diff.diff).toContain("before");
		expect(result.diff.diff).toContain("after");
	});

	test("stages and unstages only explicit changed paths", async () => {
		const repository = await createRepository();
		await writeFile(path.join(repository, "README.md"), "after\n", "utf8");
		await writeFile(path.join(repository, "new.ts"), "export {};\n", "utf8");
		const service = new GitService();

		await service.stage(repository, ["new.ts"]);
		let overview = (await service.overview(repository)).overview;
		expect(overview.files.find((file) => file.path === "new.ts")?.staged).toBe(true);
		expect(overview.files.find((file) => file.path === "README.md")?.staged).toBe(false);

		await service.unstage(repository, ["new.ts"]);
		overview = (await service.overview(repository)).overview;
		expect(overview.files.find((file) => file.path === "new.ts")?.staged).toBe(false);
		expect(await readFile(path.join(repository, "new.ts"), "utf8")).toBe("export {};\n");
	});

	test("commits only when the declared paths exactly match the staged set", async () => {
		const repository = await createRepository();
		await writeFile(path.join(repository, "README.md"), "after\n", "utf8");
		await writeFile(path.join(repository, "new.ts"), "export {};\n", "utf8");
		const service = new GitService();
		await service.stage(repository, ["README.md", "new.ts"]);

		await expect(service.commit(repository, "incomplete", ["README.md"])).rejects.toThrow("完全一致");
		expect(git(repository, "rev-list", "--count", "HEAD")).toBe("1");

		const result = await service.commit(repository, "feat: update files", ["README.md", "new.ts"]);
		expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
		expect(git(repository, "rev-list", "--count", "HEAD")).toBe("2");
	});

	test("returns bounded log entries and rejects paths outside the repository", async () => {
		const repository = await createRepository();
		const service = new GitService();
		const result = await service.log(repository, undefined, 5);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.subject).toBe("initial");

		await writeFile(path.join(repository, "README.md"), "after\n", "utf8");
		await expect(service.diff(repository, "../outside.txt")).rejects.toThrow("不在当前仓库");
	});

	test("requires an explicit remote and branch when setting an upstream", async () => {
		const repository = await createRepository();
		const service = new GitService();

		await expect(service.push(repository, { setUpstream: true })).rejects.toThrow("同时指定远程仓库和分支");
	});
});

describe("git extension", () => {
	test("registers one structured tool and always prompts before push", () => {
		let definition: ToolDefinition | undefined;
		let commandName: string | undefined;
		const api = {
			registerTool: (tool: ToolDefinition) => {
				definition = tool;
			},
			registerCommand: (name: string) => {
				commandName = name;
			},
		} as unknown as ExtensionAPI;
		createGitExtension({
			overview: vi.fn(),
			diff: vi.fn(),
			log: vi.fn(),
			stage: vi.fn(),
			unstage: vi.fn(),
			commit: vi.fn(),
			push: vi.fn(),
		})(api);

		expect(definition?.name).toBe("git");
		expect(commandName).toBe("git");
		expect(typeof definition?.approval).toBe("function");
		if (typeof definition?.approval !== "function") throw new Error("git approval must be dynamic");
		expect(definition.approval({ operation: "overview" })).toBe("read");
		expect(definition.approval({ operation: "push" })).toMatchObject({
			tier: "exec",
			policy: "prompt",
			override: true,
		});
	});
});
