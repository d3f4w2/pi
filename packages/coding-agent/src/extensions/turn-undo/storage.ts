import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { TurnUndoSnapshot } from "./types.ts";

const MANIFEST_NAME = "manifest.json";

function workspaceKey(root: string): string {
	const normalized = resolve(root);
	return createHash("sha256")
		.update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
		.digest("hex")
		.slice(0, 24);
}

export function getWorkspaceStorageDirectory(storageRoot: string, root: string): string {
	return join(storageRoot, workspaceKey(root));
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	await rename(temporary, path);
}

export async function writeSnapshotManifest(directory: string, snapshot: TurnUndoSnapshot): Promise<void> {
	await writeJsonAtomic(join(directory, MANIFEST_NAME), snapshot);
}

function isSnapshot(value: unknown): value is TurnUndoSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<TurnUndoSnapshot>;
	return (
		candidate.version === 1 &&
		typeof candidate.id === "string" &&
		typeof candidate.root === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.headRef === "string" &&
		typeof candidate.createdAt === "string" &&
		(candidate.state === "ready" || candidate.state === "undone") &&
		Array.isArray(candidate.files) &&
		candidate.files.every((file) => {
			if (typeof file !== "object" || file === null) return false;
			const entry = file as Partial<TurnUndoSnapshot["files"][number]>;
			return (
				typeof entry.path === "string" &&
				(entry.kind === "modified" || entry.kind === "created" || entry.kind === "deleted") &&
				(entry.beforeFile === undefined || /^before-[0-9]{4}\.bin$/.test(entry.beforeFile)) &&
				(entry.beforeMode === undefined || entry.beforeMode === 0o644 || entry.beforeMode === 0o755) &&
				(entry.afterState === undefined || typeof entry.afterState === "string")
			);
		})
	);
}

export async function loadSnapshots(
	storageRoot: string,
	root: string,
): Promise<Array<{ directory: string; snapshot: TurnUndoSnapshot }>> {
	const workspaceDirectory = getWorkspaceStorageDirectory(storageRoot, root);
	let entries: string[];
	try {
		entries = await readdir(workspaceDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const snapshots: Array<{ directory: string; snapshot: TurnUndoSnapshot }> = [];
	for (const entry of entries) {
		if (!entry.startsWith("snapshot-")) continue;
		const directory = join(workspaceDirectory, entry);
		try {
			const parsed: unknown = JSON.parse(await readFile(join(directory, MANIFEST_NAME), "utf8"));
			if (isSnapshot(parsed) && resolve(parsed.root) === resolve(root))
				snapshots.push({ directory, snapshot: parsed });
		} catch {
			// Ignore incomplete or corrupt snapshots; they are never offered for restore.
		}
	}
	return snapshots.sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt));
}

export async function pruneSnapshots(storageRoot: string, root: string, maxSnapshots: number): Promise<void> {
	const snapshots = await loadSnapshots(storageRoot, root);
	for (const old of snapshots.slice(maxSnapshots)) {
		await rm(old.directory, { recursive: true, force: true });
	}
}

export function validateStoredFileName(name: string): string {
	if (basename(name) !== name || !/^before-[0-9]{4}\.bin$/.test(name)) {
		throw new Error("快照内容文件名无效");
	}
	return name;
}
