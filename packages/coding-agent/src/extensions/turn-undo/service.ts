import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	createGitBaseline,
	findGitRoot,
	getCurrentHead,
	listDirtyTrackedFiles,
	listUntrackedFiles,
	listWorkspaceChanges,
	readBaselineFile,
	readBaselineMode,
} from "./git.ts";
import {
	getWorkspaceStorageDirectory,
	loadSnapshots,
	pruneSnapshots,
	validateStoredFileName,
	writeJsonAtomic,
	writeSnapshotManifest,
} from "./storage.ts";
import type {
	BaselineTrackedOverride,
	BaselineUntrackedFile,
	TurnUndoBeginResult,
	TurnUndoCapture,
	TurnUndoFileChange,
	TurnUndoFinalizeResult,
	TurnUndoLimits,
	TurnUndoResult,
	TurnUndoSnapshot,
} from "./types.ts";

const DEFAULT_LIMITS: TurnUndoLimits = {
	maxFileBytes: 5 * 1024 * 1024,
	maxSnapshotBytes: 50 * 1024 * 1024,
	maxUntrackedFiles: 500,
	maxChangedFiles: 500,
	maxSnapshots: 20,
};

interface TurnUndoServiceOptions {
	storageRoot: string;
	limits?: Partial<TurnUndoLimits>;
}

interface FileState {
	exists: boolean;
	state?: string;
	guardState?: string;
	mode?: number;
	size: number;
	content?: Buffer;
}

interface PreparedRestore {
	change: TurnUndoFileChange;
	target: string;
	prepared?: string;
	backup: string;
	committed: boolean;
}

class SnapshotUnavailableError extends Error {}

function fileMode(mode: number): number {
	return mode & 0o111 ? 0o755 : 0o644;
}

function stateHash(content: Buffer, mode: number): string {
	return `${mode.toString(8)}:${createHash("sha256").update(content).digest("hex")}`;
}

function isInside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function nearestExistingParent(path: string): Promise<string> {
	let current = path;
	while (true) {
		try {
			await stat(current);
			return current;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

async function safeTarget(root: string, realRoot: string, repositoryPath: string): Promise<string> {
	if (!repositoryPath || repositoryPath.includes("\0") || isAbsolute(repositoryPath)) {
		throw new SnapshotUnavailableError(`不安全的文件路径：${repositoryPath || "<empty>"}`);
	}
	const target = resolve(root, repositoryPath);
	if (!isInside(root, target) || target === root) {
		throw new SnapshotUnavailableError(`文件超出项目范围：${repositoryPath}`);
	}
	const parent = await nearestExistingParent(dirname(target));
	const resolvedParent = await realpath(parent);
	if (!isInside(realRoot, resolvedParent)) {
		throw new SnapshotUnavailableError(`文件父目录通过链接超出项目：${repositoryPath}`);
	}
	return target;
}

async function readCurrentFileState(
	root: string,
	realRoot: string,
	repositoryPath: string,
	maxBytes: number,
	includeContent: boolean,
): Promise<FileState> {
	const target = await safeTarget(root, realRoot, repositoryPath);
	let info: Stats;
	try {
		info = await lstat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, size: 0 };
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new SnapshotUnavailableError(`只支持普通文件：${repositoryPath}`);
	}
	if (info.size > maxBytes) {
		throw new SnapshotUnavailableError(`文件超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB：${repositoryPath}`);
	}
	const content = await readFile(target);
	const mode = fileMode(info.mode);
	const contentState = stateHash(content, mode);
	return {
		exists: true,
		state: contentState,
		guardState: `${contentState}:${info.mtimeMs}:${info.birthtimeMs}`,
		mode,
		size: content.length,
		content: includeContent ? content : undefined,
	};
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class TurnUndoService {
	private readonly storageRoot: string;
	private readonly limits: TurnUndoLimits;

	constructor(options: TurnUndoServiceOptions) {
		this.storageRoot = resolve(options.storageRoot);
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
	}

	private acquireLock(workspaceDirectory: string, sessionId: string): string | undefined {
		mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
		const lockDirectory = join(workspaceDirectory, "active.lock");
		const tryCreate = (): string | undefined => {
			try {
				mkdirSync(lockDirectory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
				throw error;
			}
			const token = randomUUID();
			try {
				writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ token, pid: process.pid, sessionId }), {
					flag: "wx",
					mode: 0o600,
				});
			} catch (error) {
				rmSync(lockDirectory, { recursive: true, force: true });
				throw error;
			}
			return token;
		};
		const created = tryCreate();
		if (created) return created;
		try {
			const owner = JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8")) as { pid?: number };
			if (typeof owner.pid === "number" && isProcessAlive(owner.pid)) return undefined;
		} catch {
			try {
				const age = Date.now() - statSync(lockDirectory).mtimeMs;
				if (age < 60_000) return undefined;
			} catch {
				return undefined;
			}
		}
		rmSync(lockDirectory, { recursive: true, force: true });
		return tryCreate();
	}

	release(capture: Pick<TurnUndoCapture, "workspaceDirectory" | "lockToken">): void {
		const lockDirectory = join(capture.workspaceDirectory, "active.lock");
		try {
			const owner = JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8")) as { token?: string };
			if (owner.token === capture.lockToken) rmSync(lockDirectory, { recursive: true, force: true });
		} catch {
			// A missing or foreign lock is left untouched.
		}
	}

	async begin(cwd: string, sessionId: string): Promise<TurnUndoBeginResult> {
		const discoveredRoot = await findGitRoot(cwd);
		if (!discoveredRoot) return { status: "skipped", reason: "当前目录不是 Git 项目，无法完整追踪终端文件变化" };
		const root = resolve(discoveredRoot);
		const realRoot = await realpath(root);
		if (isInside(root, this.storageRoot)) {
			return { status: "skipped", reason: "撤销快照目录位于项目内部，会形成递归快照" };
		}
		const workspaceDirectory = getWorkspaceStorageDirectory(this.storageRoot, root);
		const lockToken = this.acquireLock(workspaceDirectory, sessionId);
		if (!lockToken) return { status: "skipped", reason: "另一个 Pi 会话正在记录这个项目" };
		const id = randomUUID();
		const directory = join(workspaceDirectory, `pending-${id}`);
		const captureBase = { workspaceDirectory, lockToken };
		try {
			const { headRef, baseRef } = await createGitBaseline(root);
			const untrackedPaths = await listUntrackedFiles(root);
			if (untrackedPaths.length > this.limits.maxUntrackedFiles) {
				throw new SnapshotUnavailableError(`未跟踪文件超过 ${this.limits.maxUntrackedFiles} 个`);
			}
			const dirtyTrackedPaths = await listDirtyTrackedFiles(root, headRef);
			if (dirtyTrackedPaths.length > this.limits.maxChangedFiles) {
				throw new SnapshotUnavailableError(`起始脏文件超过 ${this.limits.maxChangedFiles} 个`);
			}
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const untracked: BaselineUntrackedFile[] = [];
			const trackedOverrides: BaselineTrackedOverride[] = [];
			let totalBytes = 0;
			for (const [index, path] of untrackedPaths.entries()) {
				const file = await readCurrentFileState(root, realRoot, path, this.limits.maxFileBytes, true);
				if (!file.exists || !file.content || file.state === undefined || file.mode === undefined) continue;
				totalBytes += file.size;
				if (totalBytes > this.limits.maxSnapshotBytes) {
					throw new SnapshotUnavailableError("起始未跟踪文件超过快照总量上限");
				}
				const storedFile = `untracked-${index.toString().padStart(4, "0")}.bin`;
				await writeFile(join(directory, storedFile), file.content, { flag: "wx", mode: 0o600 });
				untracked.push({ path, storedFile, state: file.state, mode: file.mode, size: file.size });
			}
			for (const [index, path] of dirtyTrackedPaths.entries()) {
				const file = await readCurrentFileState(root, realRoot, path, this.limits.maxFileBytes, true);
				totalBytes += file.size;
				if (totalBytes > this.limits.maxSnapshotBytes) {
					throw new SnapshotUnavailableError("起始脏文件超过快照总量上限");
				}
				const override: BaselineTrackedOverride = {
					path,
					state: file.state,
					mode: file.mode,
					size: file.size,
				};
				if (file.exists && file.content) {
					const storedFile = `tracked-${index.toString().padStart(4, "0")}.bin`;
					await writeFile(join(directory, storedFile), file.content, { flag: "wx", mode: 0o600 });
					override.storedFile = storedFile;
				}
				trackedOverrides.push(override);
			}
			const capture: TurnUndoCapture = {
				id,
				root,
				realRoot,
				sessionId,
				startedAt: new Date().toISOString(),
				headRef,
				baseRef,
				directory,
				workspaceDirectory,
				lockToken,
				untracked,
				trackedOverrides,
			};
			await writeJsonAtomic(join(directory, "pending.json"), capture);
			return { status: "started", capture };
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			this.release(captureBase);
			return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async finalize(capture: TurnUndoCapture): Promise<TurnUndoFinalizeResult> {
		try {
			if ((await getCurrentHead(capture.root)) !== capture.headRef) {
				await rm(capture.directory, { recursive: true, force: true });
				return { status: "skipped", reason: "本回合改变了 Git HEAD；为避免改写历史，未创建撤销快照" };
			}
			const trackedChanges = await listWorkspaceChanges(capture.root, capture.baseRef);
			const unsupported = trackedChanges.find((change) => !/^[AMDT]$/.test(change.status));
			if (unsupported)
				throw new SnapshotUnavailableError(`不支持的 Git 状态 ${unsupported.status}：${unsupported.path}`);
			const tracked = new Map(trackedChanges.map((change) => [change.path, change.status]));
			const baselineUntracked = new Map(capture.untracked.map((file) => [file.path, file]));
			const trackedOverrides = new Map(capture.trackedOverrides.map((file) => [file.path, file]));
			const currentUntracked = await listUntrackedFiles(capture.root);
			if (currentUntracked.length > this.limits.maxUntrackedFiles) {
				throw new SnapshotUnavailableError(`未跟踪文件超过 ${this.limits.maxUntrackedFiles} 个`);
			}
			const candidates = new Set([
				...tracked.keys(),
				...baselineUntracked.keys(),
				...trackedOverrides.keys(),
				...currentUntracked,
			]);
			if (candidates.size > this.limits.maxChangedFiles) {
				throw new SnapshotUnavailableError(`候选变化文件超过 ${this.limits.maxChangedFiles} 个`);
			}
			const files: TurnUndoFileChange[] = [];
			let totalBytes = 0;

			for (const path of [...candidates].sort()) {
				const current = await readCurrentFileState(
					capture.root,
					capture.realRoot,
					path,
					this.limits.maxFileBytes,
					true,
				);
				const untrackedBefore = baselineUntracked.get(path);
				const trackedOverride = trackedOverrides.get(path);
				let beforeContent: Buffer | undefined;
				let beforeMode: number | undefined;
				let beforeState: string | undefined;
				const trackedStatus = tracked.get(path);
				if (trackedOverride) {
					beforeContent = trackedOverride.storedFile
						? await readFile(join(capture.directory, trackedOverride.storedFile))
						: undefined;
					beforeMode = trackedOverride.mode;
					beforeState = trackedOverride.state;
				} else if (untrackedBefore) {
					beforeContent = await readFile(join(capture.directory, untrackedBefore.storedFile));
					beforeMode = untrackedBefore.mode;
					beforeState = untrackedBefore.state;
				} else if (trackedStatus !== undefined && trackedStatus !== "A") {
					beforeContent = await readBaselineFile(capture.root, capture.baseRef, path);
					if (beforeContent.length > this.limits.maxFileBytes) {
						throw new SnapshotUnavailableError(`文件超过安全上限：${path}`);
					}
					beforeMode = await readBaselineMode(capture.root, capture.baseRef, path);
					beforeState = stateHash(beforeContent, beforeMode);
				}
				if (beforeState === current.state || (beforeState === undefined && !current.exists)) continue;
				totalBytes += current.size + (beforeContent?.length ?? 0);
				if (totalBytes > this.limits.maxSnapshotBytes) {
					throw new SnapshotUnavailableError("本回合文件变化超过快照总量上限");
				}
				const kind = beforeState === undefined ? "created" : current.exists ? "modified" : "deleted";
				const change: TurnUndoFileChange = {
					path,
					kind,
					beforeMode,
					afterState: current.guardState,
				};
				if (beforeContent) {
					const beforeFile = `before-${files.length.toString().padStart(4, "0")}.bin`;
					await writeFile(join(capture.directory, beforeFile), beforeContent, { flag: "wx", mode: 0o600 });
					change.beforeFile = beforeFile;
				}
				files.push(change);
			}

			if (files.length === 0) {
				await rm(capture.directory, { recursive: true, force: true });
				return { status: "unchanged" };
			}
			const snapshot: TurnUndoSnapshot = {
				version: 1,
				id: capture.id,
				root: capture.root,
				sessionId: capture.sessionId,
				headRef: capture.headRef,
				createdAt: new Date().toISOString(),
				state: "ready",
				files,
			};
			await rm(join(capture.directory, "pending.json"), { force: true });
			for (const file of capture.untracked) await rm(join(capture.directory, file.storedFile), { force: true });
			for (const file of capture.trackedOverrides) {
				if (file.storedFile) await rm(join(capture.directory, file.storedFile), { force: true });
			}
			await writeSnapshotManifest(capture.directory, snapshot);
			const finalDirectory = join(capture.workspaceDirectory, `snapshot-${Date.now()}-${capture.id}`);
			await rename(capture.directory, finalDirectory);
			await pruneSnapshots(this.storageRoot, capture.root, this.limits.maxSnapshots);
			return { status: "saved", snapshot };
		} catch (error) {
			await rm(capture.directory, { recursive: true, force: true });
			return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
		} finally {
			this.release(capture);
		}
	}

	async undoLatest(cwd: string): Promise<TurnUndoResult> {
		const discoveredRoot = await findGitRoot(cwd);
		if (!discoveredRoot) return { status: "failed", reason: "当前目录不是 Git 项目" };
		const root = resolve(discoveredRoot);
		const realRoot = await realpath(root);
		const workspaceDirectory = getWorkspaceStorageDirectory(this.storageRoot, root);
		const lockToken = this.acquireLock(workspaceDirectory, "undo");
		if (!lockToken) return { status: "busy", reason: "另一个 Pi 会话正在修改或记录这个项目" };
		const lock = { workspaceDirectory, lockToken };
		try {
			const latest = (await loadSnapshots(this.storageRoot, root)).find((entry) => entry.snapshot.state === "ready");
			if (!latest) return { status: "none" };
			if ((await getCurrentHead(root)) !== latest.snapshot.headRef) {
				return { status: "failed", reason: "Git HEAD 已改变；为避免在新的提交状态上覆盖文件，撤销已取消" };
			}
			const conflicts: string[] = [];
			for (const change of latest.snapshot.files) {
				const current = await readCurrentFileState(root, realRoot, change.path, this.limits.maxFileBytes, false);
				if (current.guardState !== change.afterState) conflicts.push(change.path);
			}
			if (conflicts.length > 0) return { status: "conflict", paths: conflicts.sort() };

			const prepared: PreparedRestore[] = [];
			try {
				for (const change of latest.snapshot.files) {
					const target = await safeTarget(root, realRoot, change.path);
					await mkdir(dirname(target), { recursive: true });
					const suffix = randomUUID();
					const backup = join(dirname(target), `.${basename(target)}.pi-undo-${suffix}.backup`);
					let restored: string | undefined;
					if (change.beforeFile) {
						const beforeFile = validateStoredFileName(change.beforeFile);
						const content = await readFile(join(latest.directory, beforeFile));
						restored = join(dirname(target), `.${basename(target)}.pi-undo-${suffix}.restore`);
						await writeFile(restored, content, { flag: "wx", mode: change.beforeMode ?? 0o644 });
					}
					prepared.push({ change, target, prepared: restored, backup, committed: false });
				}

				for (const entry of prepared) {
					if (existsSync(entry.target)) await rename(entry.target, entry.backup);
					if (entry.prepared) {
						await rename(entry.prepared, entry.target);
						if (entry.change.beforeMode !== undefined) await chmod(entry.target, entry.change.beforeMode);
					}
					entry.committed = true;
				}
			} catch (error) {
				for (const entry of [...prepared].reverse()) {
					try {
						if (entry.committed && existsSync(entry.target)) await rm(entry.target, { force: true });
						if (existsSync(entry.backup)) await rename(entry.backup, entry.target);
						if (entry.prepared && existsSync(entry.prepared)) await rm(entry.prepared, { force: true });
					} catch {
						// Keep trying to restore the remaining entries.
					}
				}
				return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
			}
			const undone = { ...latest.snapshot, state: "undone" as const };
			let warning: string | undefined;
			try {
				await writeSnapshotManifest(latest.directory, undone);
			} catch {
				warning = "文件已恢复，但快照完成标记保存失败；不要重复执行同一快照";
			}
			for (const entry of prepared) {
				try {
					if (existsSync(entry.backup)) await rm(entry.backup, { force: true });
				} catch {
					warning ??= "文件已恢复，但部分内部备份清理失败";
				}
			}
			return { status: "restored", snapshot: undone, ...(warning === undefined ? {} : { warning }) };
		} catch (error) {
			return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
		} finally {
			this.release(lock);
		}
	}

	async getLatest(cwd: string): Promise<TurnUndoSnapshot | undefined> {
		const discoveredRoot = await findGitRoot(cwd);
		if (!discoveredRoot) return undefined;
		return (await loadSnapshots(this.storageRoot, resolve(discoveredRoot))).find(
			(entry) => entry.snapshot.state === "ready",
		)?.snapshot;
	}
}
