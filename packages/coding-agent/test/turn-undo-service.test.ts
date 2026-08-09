import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TurnUndoService } from "../src/extensions/turn-undo/service.ts";

const tempDirs: string[] = [];

function createTempDir(name: string): string {
	const directory = mkdtempSync(join(tmpdir(), `${name}-`));
	tempDirs.push(directory);
	return directory;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(): string {
	const root = createTempDir("pi-turn-undo-repo");
	git(root, ["init"]);
	git(root, ["config", "user.email", "turn-undo@example.test"]);
	git(root, ["config", "user.name", "Turn Undo Test"]);
	git(root, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(root, "modified.ts"), "export const value = 1;\n");
	writeFileSync(join(root, "deleted.ts"), "export const removed = true;\n");
	git(root, ["add", "modified.ts", "deleted.ts"]);
	git(root, ["commit", "-m", "initial"]);
	return root;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("TurnUndoService", () => {
	it("restores modified, created, deleted, and renamed files together", async () => {
		const root = createRepository();
		const storageRoot = createTempDir("pi-turn-undo-storage");
		const service = new TurnUndoService({ storageRoot });
		const started = await service.begin(root, "session-1");
		expect(started.status).toBe("started");
		if (started.status !== "started") return;

		writeFileSync(join(root, "modified.ts"), "export const value = 2;\n");
		writeFileSync(join(root, "created.ts"), "export const created = true;\n");
		rmSync(join(root, "deleted.ts"));
		writeFileSync(join(root, "rename-source.ts"), "export const renamed = true;\n");
		git(root, ["add", "rename-source.ts"]);
		git(root, ["commit", "-m", "add rename source"]);
		// A changed HEAD must fail closed instead of moving Git history.
		const changedHead = await service.finalize(started.capture);
		expect(changedHead.status).toBe("skipped");
		service.release(started.capture);

		// Start a fresh turn with a stable HEAD and exercise rename as delete + create.
		const second = await service.begin(root, "session-1");
		expect(second.status).toBe("started");
		if (second.status !== "started") return;
		writeFileSync(join(root, "modified.ts"), "export const value = 3;\n");
		writeFileSync(join(root, "created-second.ts"), "export const created = 2;\n");
		rmSync(join(root, "rename-source.ts"));
		writeFileSync(join(root, "rename-target.ts"), "export const renamed = true;\n");

		const finalized = await service.finalize(second.capture);
		expect(finalized).toMatchObject({ status: "saved" });
		if (finalized.status !== "saved") return;
		expect(finalized.snapshot.files.map((file) => [file.kind, file.path])).toEqual([
			["created", "created-second.ts"],
			["modified", "modified.ts"],
			["deleted", "rename-source.ts"],
			["created", "rename-target.ts"],
		]);

		const restored = await service.undoLatest(root);
		expect(restored.status).toBe("restored");
		expect(readFileSync(join(root, "modified.ts"), "utf8")).toBe("export const value = 2;\n");
		expect(() => readFileSync(join(root, "created-second.ts"))).toThrow();
		expect(readFileSync(join(root, "rename-source.ts"), "utf8")).toBe("export const renamed = true;\n");
		expect(() => readFileSync(join(root, "rename-target.ts"))).toThrow();
	});

	it("refuses the entire undo when a file changed after the turn", async () => {
		const root = createRepository();
		const service = new TurnUndoService({ storageRoot: createTempDir("pi-turn-undo-storage") });
		const started = await service.begin(root, "session-2");
		expect(started.status).toBe("started");
		if (started.status !== "started") return;
		writeFileSync(join(root, "modified.ts"), "export const value = 2;\n");
		writeFileSync(join(root, "created.ts"), "created by agent\n");
		const finalized = await service.finalize(started.capture);
		expect(finalized).toMatchObject({ status: "saved" });

		writeFileSync(join(root, "modified.ts"), "changed later by user\n");
		const restored = await service.undoLatest(root);
		expect(restored.status).toBe("conflict");
		if (restored.status === "conflict") expect(restored.paths).toEqual(["modified.ts"]);
		expect(readFileSync(join(root, "modified.ts"), "utf8")).toBe("changed later by user\n");
		expect(readFileSync(join(root, "created.ts"), "utf8")).toBe("created by agent\n");
	});

	it("refuses undo when a file was touched after the turn even if its content is unchanged", async () => {
		const root = createRepository();
		const service = new TurnUndoService({ storageRoot: createTempDir("pi-turn-undo-storage") });
		const started = await service.begin(root, "session-touch");
		expect(started.status).toBe("started");
		if (started.status !== "started") return;
		writeFileSync(join(root, "modified.ts"), "agent change\n");
		expect((await service.finalize(started.capture)).status).toBe("saved");
		const future = new Date(Date.now() + 60_000);
		utimesSync(join(root, "modified.ts"), future, future);

		const restored = await service.undoLatest(root);
		expect(restored.status).toBe("conflict");
		expect(readFileSync(join(root, "modified.ts"), "utf8")).toBe("agent change\n");
	});

	it("preserves dirty and untracked files that existed before the turn", async () => {
		const root = createRepository();
		writeFileSync(join(root, "modified.ts"), "dirty before turn\r\nmixed ending\n");
		writeFileSync(join(root, "notes.txt"), "untracked before turn\n");
		const service = new TurnUndoService({ storageRoot: createTempDir("pi-turn-undo-storage") });
		const started = await service.begin(root, "session-3");
		expect(started.status).toBe("started");
		if (started.status !== "started") return;

		writeFileSync(join(root, "modified.ts"), "agent changed dirty file\n");
		writeFileSync(join(root, "notes.txt"), "agent changed untracked file\n");
		const finalized = await service.finalize(started.capture);
		expect(finalized.status).toBe("saved");
		const restored = await service.undoLatest(root);
		expect(restored.status).toBe("restored");
		expect(readFileSync(join(root, "modified.ts"), "utf8")).toBe("dirty before turn\r\nmixed ending\n");
		expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("untracked before turn\n");
	});

	it("restores clean files using Git checkout filters", async () => {
		const root = createRepository();
		writeFileSync(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
		writeFileSync(join(root, "eol.txt"), "first\nsecond\n");
		git(root, ["add", ".gitattributes", "eol.txt"]);
		git(root, ["commit", "-m", "add eol fixture"]);
		rmSync(join(root, "eol.txt"));
		git(root, ["checkout", "HEAD", "--", "eol.txt"]);
		const baseline = readFileSync(join(root, "eol.txt"));
		expect(baseline.toString("utf8")).toBe("first\r\nsecond\r\n");
		const service = new TurnUndoService({ storageRoot: createTempDir("pi-turn-undo-storage") });
		const started = await service.begin(root, "session-eol");
		expect(started.status).toBe("started");
		if (started.status !== "started") return;
		writeFileSync(join(root, "eol.txt"), "changed\n");
		expect((await service.finalize(started.capture)).status).toBe("saved");
		expect((await service.undoLatest(root)).status).toBe("restored");
		expect(readFileSync(join(root, "eol.txt"))).toEqual(baseline);
	});

	it("refuses undo after Git HEAD changes", async () => {
		const root = createRepository();
		const service = new TurnUndoService({ storageRoot: createTempDir("pi-turn-undo-storage") });
		const started = await service.begin(root, "session-head");
		expect(started.status).toBe("started");
		if (started.status !== "started") return;
		writeFileSync(join(root, "modified.ts"), "agent change\n");
		expect((await service.finalize(started.capture)).status).toBe("saved");
		git(root, ["add", "modified.ts"]);
		git(root, ["commit", "-m", "user committed after turn"]);

		const restored = await service.undoLatest(root);
		expect(restored.status).toBe("failed");
		if (restored.status === "failed") expect(restored.reason).toContain("HEAD");
		expect(readFileSync(join(root, "modified.ts"), "utf8")).toBe("agent change\n");
	});

	it("skips non-Git projects without claiming they are protected", async () => {
		const root = createTempDir("pi-turn-undo-plain");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "index.ts"), "export {};\n");
		const service = new TurnUndoService({ storageRoot: createTempDir("pi-turn-undo-storage") });
		const result = await service.begin(root, "session-4");
		expect(result.status).toBe("skipped");
		if (result.status === "skipped") expect(result.reason).toContain("Git");
	});
});
