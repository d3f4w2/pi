import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { spawnProcessSync } from "../utils/child-process.ts";
import { canonicalJson } from "./run-contract.ts";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const ABSENT_FINGERPRINT = "absent";

export interface WorkspaceSnapshot {
	root: string;
	head: string | null;
	digest: string;
	coverage: "git-tracked-and-unignored";
	index: ReadonlyMap<string, string>;
	dirty: ReadonlyMap<string, string>;
}

export interface WorkspaceChange {
	path: string;
	before: string;
	after: string;
}

export interface WorkspaceComparison {
	headBefore: string | null;
	headAfter: string | null;
	headChanged: boolean;
	beforeDigest: string;
	afterDigest: string;
	changed: WorkspaceChange[];
	scopeViolations: string[];
}

interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnProcessSync("git", args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: GIT_MAX_BUFFER,
	});
	if (result.error) throw new Error(`无法运行 Git：${result.error.message}`);
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function requiredGit(cwd: string, args: string[], label: string): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const detail = result.stderr.trim().split(/\r?\n/, 1)[0];
		throw new Error(`${label}${detail ? `：${detail}` : "。"}`);
	}
	return result.stdout;
}

function samePath(first: string, second: string): boolean {
	const normalizedFirst = path.resolve(first);
	const normalizedSecond = path.resolve(second);
	return process.platform === "win32"
		? normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase()
		: normalizedFirst === normalizedSecond;
}

function portablePath(value: string): string {
	return value.replaceAll("\\", "/");
}

export async function getGitWorkspaceRoot(cwd: string): Promise<string> {
	const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0) throw new Error("pigo run 需要在 Git 工作区内执行。");
	return path.resolve(result.stdout.trim());
}

function readHead(root: string): string | null {
	const result = runGit(root, ["rev-parse", "--verify", "HEAD"]);
	return result.status === 0 ? result.stdout.trim() : null;
}

function readIndex(root: string): Map<string, string> {
	const output = requiredGit(root, ["ls-files", "--stage", "-z"], "无法读取 Git 索引");
	const index = new Map<string, string>();
	for (const record of output.split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		if (tab === -1) continue;
		const metadata = record.slice(0, tab).split(" ");
		const filePath = portablePath(record.slice(tab + 1));
		if (metadata.length !== 3 || metadata[2] !== "0") continue;
		index.set(filePath, `${metadata[0]}:${metadata[1]}`);
	}
	return index;
}

function readDirtyPaths(root: string): string[] {
	const output = requiredGit(
		root,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		"无法读取 Git 工作区状态",
	);
	const records = output.split("\0");
	const paths = new Set<string>();
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record || record.length < 4) continue;
		const status = record.slice(0, 2);
		paths.add(portablePath(record.slice(3)));
		if (/[RC]/.test(status)) {
			const source = records[index + 1];
			if (source) paths.add(portablePath(source));
			index += 1;
		}
	}
	return [...paths].sort();
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

async function hashFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function fingerprintWorktreePath(root: string, relativePath: string): Promise<string> {
	const absolutePath = path.join(root, ...relativePath.split("/"));
	try {
		const stats = await lstat(absolutePath);
		const executable = (stats.mode & 0o111) === 0 ? "0" : "1";
		if (stats.isSymbolicLink()) {
			const target = await readlink(absolutePath);
			return `symlink:${createHash("sha256").update(target).digest("hex")}`;
		}
		if (stats.isFile()) return `file:${await hashFile(absolutePath)}:x${executable}`;
		if (stats.isDirectory()) return "directory";
		return `other:${stats.mode}:${stats.size}`;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return ABSENT_FINGERPRINT;
		throw error;
	}
}

function digestSnapshot(head: string | null, dirty: ReadonlyMap<string, string>): string {
	return createHash("sha256")
		.update(
			canonicalJson({ head, dirty: [...dirty.entries()].sort(([first], [second]) => first.localeCompare(second)) }),
		)
		.digest("hex");
}

export async function takeWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
	const root = await getGitWorkspaceRoot(cwd);
	const index = readIndex(root);
	const dirtyPaths = readDirtyPaths(root);
	const dirtyEntries = await Promise.all(
		dirtyPaths.map(async (relativePath) => {
			const indexIdentity = index.get(relativePath) ?? ABSENT_FINGERPRINT;
			const worktreeIdentity = await fingerprintWorktreePath(root, relativePath);
			return [relativePath, `dirty:index=${indexIdentity}:worktree=${worktreeIdentity}`] as const;
		}),
	);
	const dirty = new Map(dirtyEntries);
	const head = readHead(root);
	return {
		root,
		head,
		digest: digestSnapshot(head, dirty),
		coverage: "git-tracked-and-unignored",
		index,
		dirty,
	};
}

function pathState(snapshot: WorkspaceSnapshot, relativePath: string): string {
	const dirty = snapshot.dirty.get(relativePath);
	if (dirty !== undefined) return dirty;
	const index = snapshot.index.get(relativePath);
	return index === undefined ? ABSENT_FINGERPRINT : `clean:index=${index}`;
}

function isInScope(relativePath: string, scopes: readonly string[]): boolean {
	return scopes.some((scope) => scope === "." || relativePath === scope || relativePath.startsWith(`${scope}/`));
}

export function compareWorkspaceSnapshots(
	before: WorkspaceSnapshot,
	after: WorkspaceSnapshot,
	scopes: readonly string[],
): WorkspaceComparison {
	if (!samePath(before.root, after.root)) throw new Error("运行前后的 Git 工作区不一致。");
	const candidates = new Set([...before.dirty.keys(), ...after.dirty.keys()]);
	const changed: WorkspaceChange[] = [];
	for (const relativePath of [...candidates].sort()) {
		const beforeState = pathState(before, relativePath);
		const afterState = pathState(after, relativePath);
		if (beforeState !== afterState) changed.push({ path: relativePath, before: beforeState, after: afterState });
	}
	return {
		headBefore: before.head,
		headAfter: after.head,
		headChanged: before.head !== after.head,
		beforeDigest: before.digest,
		afterDigest: after.digest,
		changed,
		scopeViolations: changed.filter((entry) => !isInScope(entry.path, scopes)).map((entry) => entry.path),
	};
}
