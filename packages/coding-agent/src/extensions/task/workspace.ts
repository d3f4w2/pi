import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const WORKSPACE_PREFIX = "pi-task-worker-";
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const EXCLUDED_NAMES = new Set([".git", ".artifacts", ".eval", "coverage", "dist", "node_modules", "tmp"]);

export interface IsolatedWorkspace {
	rootPath: string;
	workspacePath: string;
	baseline: ReadonlyMap<string, string>;
}

interface WalkLimits {
	files: number;
	bytes: number;
}

function portablePath(path: string): string {
	return path.split(sep).join("/");
}

function assertWithinWorkspace(rootPath: string, path: string): void {
	const rel = relative(resolve(rootPath), resolve(path));
	if (rel === "") return;
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`Path escapes task workspace: ${path}`);
	}
}

async function hashFile(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function copyTree(sourceRoot: string, targetRoot: string, limits: WalkLimits, directory = ""): Promise<void> {
	const sourceDirectory = join(sourceRoot, directory);
	const targetDirectory = join(targetRoot, directory);
	await mkdir(targetDirectory, { recursive: true });
	const entries = await readdir(sourceDirectory, { withFileTypes: true });
	for (const entry of entries) {
		if (EXCLUDED_NAMES.has(entry.name)) continue;
		const relativePath = join(directory, entry.name);
		const sourcePath = join(sourceRoot, relativePath);
		const targetPath = join(targetRoot, relativePath);
		assertWithinWorkspace(targetRoot, targetPath);
		const stats = await lstat(sourcePath);
		if (stats.isSymbolicLink()) continue;
		if (stats.isDirectory()) {
			await copyTree(sourceRoot, targetRoot, limits, relativePath);
			continue;
		}
		if (!stats.isFile()) continue;
		limits.files++;
		limits.bytes += stats.size;
		if (limits.files > MAX_FILES || limits.bytes > MAX_BYTES) {
			throw new Error(`Task workspace exceeds ${MAX_FILES} files or ${MAX_BYTES} bytes`);
		}
		await copyFile(sourcePath, targetPath);
	}
}

export async function manifestWorkspace(rootPath: string, directory = ""): Promise<Map<string, string>> {
	const manifest = new Map<string, string>();
	const entries = await readdir(join(rootPath, directory), { withFileTypes: true });
	for (const entry of entries) {
		const relativePath = join(directory, entry.name);
		const absolutePath = join(rootPath, relativePath);
		assertWithinWorkspace(rootPath, absolutePath);
		const stats = await lstat(absolutePath);
		if (stats.isSymbolicLink()) continue;
		if (stats.isDirectory()) {
			for (const [path, hash] of await manifestWorkspace(rootPath, relativePath)) manifest.set(path, hash);
		} else if (stats.isFile()) {
			manifest.set(portablePath(relativePath), await hashFile(absolutePath));
		}
	}
	return manifest;
}

export async function createIsolatedWorkspace(sourcePath: string): Promise<IsolatedWorkspace> {
	const sourceRoot = resolve(sourcePath);
	const rootPath = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
	const workspacePath = join(rootPath, "workspace");
	try {
		await copyTree(sourceRoot, workspacePath, { files: 0, bytes: 0 });
		return { rootPath, workspacePath, baseline: await manifestWorkspace(workspacePath) };
	} catch (error) {
		await disposeIsolatedWorkspace(rootPath);
		throw error;
	}
}

export async function changedWorkspaceFiles(workspace: IsolatedWorkspace): Promise<string[]> {
	const current = await manifestWorkspace(workspace.workspacePath);
	const paths = new Set([...workspace.baseline.keys(), ...current.keys()]);
	return [...paths].filter((path) => workspace.baseline.get(path) !== current.get(path)).sort();
}

export async function disposeIsolatedWorkspace(rootPath: string): Promise<void> {
	const resolvedRoot = resolve(rootPath);
	if (dirname(resolvedRoot) !== resolve(tmpdir()) || !basename(resolvedRoot).startsWith(WORKSPACE_PREFIX)) {
		throw new Error(`Refusing to remove unrecognized task workspace: ${rootPath}`);
	}
	await rm(resolvedRoot, { recursive: true, force: true });
}
