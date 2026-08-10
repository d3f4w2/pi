import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GitService } from "../src/extensions/git/service.ts";

const tempDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function gitFailure(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	if (result.status === 0) throw new Error(`Expected git ${args.join(" ")} to fail`);
	return result.stderr || result.stdout;
}

async function createRepository(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-git-workflow-"));
	tempDirectories.push(directory);
	git(directory, "init", "--initial-branch=main");
	git(directory, "config", "user.name", "Pi Test");
	git(directory, "config", "user.email", "pi@example.com");
	await writeFile(path.join(directory, "base.txt"), "base\n", "utf8");
	git(directory, "add", "base.txt");
	git(directory, "commit", "-m", "initial");
	return directory;
}

async function createConflict(): Promise<string> {
	const repository = await createRepository();
	git(repository, "switch", "-c", "incoming");
	await writeFile(path.join(repository, "base.txt"), "theirs\n", "utf8");
	git(repository, "commit", "-am", "incoming");
	git(repository, "switch", "main");
	await writeFile(path.join(repository, "base.txt"), "ours\n", "utf8");
	git(repository, "commit", "-am", "ours");
	gitFailure(repository, "merge", "incoming");
	return repository;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("git commit plan validation", () => {
	test("requires exact coverage and returns dependency order without changing Git", async () => {
		const repository = await createRepository();
		await writeFile(path.join(repository, "base.txt"), "implementation\n", "utf8");
		await writeFile(path.join(repository, "base.test.ts"), "test\n", "utf8");
		await writeFile(path.join(repository, "notes.md"), "docs\n", "utf8");
		const service = new GitService();

		const result = await service.validateCommitPlan(repository, [
			{ id: "implementation", message: "feat: update implementation", paths: ["base.txt"], dependsOn: [] },
			{ id: "tests", message: "test: cover implementation", paths: ["base.test.ts"], dependsOn: ["implementation"] },
			{ id: "docs", message: "docs: explain implementation", paths: ["notes.md"], dependsOn: ["tests"] },
		]);

		expect(result.executionOrder).toEqual(["implementation", "tests", "docs"]);
		expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
		expect(git(repository, "diff", "--cached", "--name-only")).toBe("");
	});

	test("rejects missing, duplicate, unknown, and cyclic groups", async () => {
		const repository = await createRepository();
		await writeFile(path.join(repository, "base.txt"), "changed\n", "utf8");
		await writeFile(path.join(repository, "other.ts"), "changed\n", "utf8");
		const service = new GitService();

		await expect(
			service.validateCommitPlan(repository, [
				{ id: "one", message: "feat: one", paths: ["base.txt"], dependsOn: [] },
			]),
		).rejects.toThrow("未覆盖");
		await expect(
			service.validateCommitPlan(repository, [
				{ id: "one", message: "feat: one", paths: ["base.txt", "other.ts"], dependsOn: [] },
				{ id: "two", message: "feat: two", paths: ["other.ts"], dependsOn: [] },
			]),
		).rejects.toThrow("重复");
		await expect(
			service.validateCommitPlan(repository, [
				{ id: "one", message: "feat: one", paths: ["base.txt", "base.txt"], dependsOn: [] },
				{ id: "two", message: "feat: two", paths: ["other.ts"], dependsOn: [] },
			]),
		).rejects.toThrow("组 one 内有重复文件");
		await expect(
			service.validateCommitPlan(repository, [
				{ id: "one", message: "feat: one", paths: ["base.txt", "unknown.ts"], dependsOn: [] },
				{ id: "two", message: "feat: two", paths: ["other.ts"], dependsOn: [] },
			]),
		).rejects.toThrow("不是当前变更");
		await expect(
			service.validateCommitPlan(repository, [
				{ id: "one", message: "feat: one", paths: ["base.txt"], dependsOn: ["two"] },
				{ id: "two", message: "feat: two", paths: ["other.ts"], dependsOn: ["one"] },
			]),
		).rejects.toThrow("依赖环");
	});
});

describe("git conflict workflow", () => {
	test("reads index variants and resolves a stale-safe whole-file choice", async () => {
		const repository = await createConflict();
		const service = new GitService();
		const listed = await service.conflicts(repository);
		const conflict = listed.conflicts[0];

		expect(conflict).toMatchObject({ path: "base.txt" });
		expect(conflict?.variants.ours?.preview).toContain("ours");
		expect(conflict?.variants.theirs?.preview).toContain("theirs");
		if (!conflict) throw new Error("expected one conflict");

		await expect(
			service.resolveConflict(repository, {
				path: conflict.path,
				resolution: "ours",
				revision: "stale",
			}),
		).rejects.toThrow("已经变化");

		const resolved = await service.resolveConflict(repository, {
			path: conflict.path,
			resolution: "ours",
			revision: conflict.revision,
		});

		expect(resolved.path).toBe("base.txt");
		expect((await readFile(path.join(repository, "base.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("ours\n");
		expect(git(repository, "diff", "--name-only", "--diff-filter=U")).toBe("");
		expect((await service.overview(repository)).overview.files.some((file) => file.conflicted)).toBe(false);
	});

	test("requires the current worktree fingerprint and rejects residual markers", async () => {
		const repository = await createConflict();
		const service = new GitService();
		let conflict = (await service.conflicts(repository)).conflicts[0];
		if (!conflict) throw new Error("expected one conflict");

		await expect(
			service.resolveConflict(repository, {
				path: conflict.path,
				resolution: "worktree",
				revision: conflict.revision,
				worktreeHash: conflict.worktreeHash,
			}),
		).rejects.toThrow("冲突标记");

		await writeFile(path.join(repository, "base.txt"), "combined\n", "utf8");
		conflict = (await service.conflicts(repository)).conflicts[0];
		if (!conflict) throw new Error("expected one conflict");
		await expect(
			service.resolveConflict(repository, {
				path: conflict.path,
				resolution: "worktree",
				revision: conflict.revision,
				worktreeHash: "stale",
			}),
		).rejects.toThrow("工作树文件已经变化");

		await service.resolveConflict(repository, {
			path: conflict.path,
			resolution: "worktree",
			revision: conflict.revision,
			worktreeHash: conflict.worktreeHash,
		});

		expect(await readFile(path.join(repository, "base.txt"), "utf8")).toBe("combined\n");
		expect(git(repository, "diff", "--name-only", "--diff-filter=U")).toBe("");
	});

	test("preserves CRLF worktree line endings for an index variant", async () => {
		const repository = await createConflict();
		const conflictPath = path.join(repository, "base.txt");
		const marked = await readFile(conflictPath, "utf8");
		await writeFile(conflictPath, marked.replace(/\r?\n/g, "\r\n"), "utf8");
		const service = new GitService();
		const conflict = (await service.conflicts(repository)).conflicts[0];
		if (!conflict) throw new Error("expected one conflict");

		await service.resolveConflict(repository, {
			path: conflict.path,
			resolution: "ours",
			revision: conflict.revision,
		});

		expect(await readFile(conflictPath, "utf8")).toBe("ours\r\n");
	});
});
