import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const MAX_CI_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_CI_RECEIPTS = 10_000;
const MAX_CI_DIRECTORIES = 20_000;

export interface CiReceiptFile {
	absolutePath: string;
	displayPath: string;
	modifiedMs: number;
}

export function selectLatestCiReceiptFile(files: readonly CiReceiptFile[]): CiReceiptFile {
	const first = files[0];
	if (!first) throw new Error("No receipt JSON files were found.");
	return files.slice(1).reduce((latest, candidate) => {
		if (candidate.modifiedMs !== latest.modifiedMs) {
			return candidate.modifiedMs > latest.modifiedMs ? candidate : latest;
		}
		return candidate.displayPath.localeCompare(latest.displayPath) > 0 ? candidate : latest;
	}, first);
}

function displayPath(absolutePath: string, cwd: string): string {
	const relative = path.relative(cwd, absolutePath);
	if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
		return relative.split(path.sep).join("/");
	}
	return absolutePath.split(path.sep).join("/");
}

function dedupeKey(absolutePath: string): string {
	return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

export async function discoverCiReceiptFiles(inputs: readonly string[], cwd: string): Promise<CiReceiptFile[]> {
	if (inputs.length === 0) throw new Error("Provide at least one receipt file or directory.");
	const discovered = new Map<string, CiReceiptFile>();
	let visitedDirectories = 0;

	const addFile = async (absolutePath: string): Promise<void> => {
		const info = await lstat(absolutePath);
		if (info.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${displayPath(absolutePath, cwd)}`);
		if (!info.isFile()) throw new Error(`Receipt input is not a regular file: ${displayPath(absolutePath, cwd)}`);
		if (info.size > MAX_CI_RECEIPT_BYTES) {
			throw new Error(`Receipt exceeds ${MAX_CI_RECEIPT_BYTES} bytes: ${displayPath(absolutePath, cwd)}`);
		}
		const key = dedupeKey(absolutePath);
		discovered.set(key, {
			absolutePath,
			displayPath: displayPath(absolutePath, cwd),
			modifiedMs: info.mtimeMs,
		});
		if (discovered.size > MAX_CI_RECEIPTS) throw new Error(`Receipt set exceeds ${MAX_CI_RECEIPTS} files.`);
	};

	const visitDirectory = async (directory: string): Promise<void> => {
		visitedDirectories += 1;
		if (visitedDirectories > MAX_CI_DIRECTORIES) {
			throw new Error(`Receipt discovery exceeds ${MAX_CI_DIRECTORIES} directories.`);
		}
		const info = await lstat(directory);
		if (info.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${displayPath(directory, cwd)}`);
		if (!info.isDirectory()) throw new Error(`Receipt input is not a directory: ${displayPath(directory, cwd)}`);
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const absolutePath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(`Symbolic links are not accepted: ${displayPath(absolutePath, cwd)}`);
			}
			if (entry.isDirectory()) {
				await visitDirectory(absolutePath);
				continue;
			}
			if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".json") await addFile(absolutePath);
		}
	};

	for (const input of inputs) {
		const absolutePath = path.resolve(cwd, input);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(absolutePath);
		} catch (error) {
			throw new Error(
				`Cannot inspect receipt input ${input}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (info.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${displayPath(absolutePath, cwd)}`);
		if (info.isDirectory()) await visitDirectory(absolutePath);
		else await addFile(absolutePath);
	}

	const files = [...discovered.values()].sort((left, right) => left.displayPath.localeCompare(right.displayPath));
	if (files.length === 0) throw new Error("No receipt JSON files were found.");
	return files;
}
