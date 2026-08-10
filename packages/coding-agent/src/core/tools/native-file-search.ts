import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import createIgnore, { type Ignore } from "ignore";
import { Minimatch } from "minimatch";

const MAX_WALKED_ENTRIES = 100_000;
const MAX_DIRECTORY_CONCURRENCY = 16;
const MAX_IGNORE_CACHE_ENTRIES = 2_048;

interface IgnoreContext {
	basePath: string;
	matcher: Ignore;
}

interface IgnoreCacheEntry {
	signature: string;
	context?: IgnoreContext;
}

export interface NativeFileEntry {
	absolutePath: string;
	relativePath: string;
	isDirectory: boolean;
}

export interface NativeWalkOptions {
	pattern?: string;
	limit?: number;
	signal?: AbortSignal;
}

const ignoreCache = new Map<string, IgnoreCacheEntry>();

function normalizeRelative(value: string): string {
	return value.replaceAll("\\", "/");
}

async function existingGitRoot(searchPath: string): Promise<string | undefined> {
	let current = searchPath;
	try {
		if (!(await stat(current)).isDirectory()) current = path.dirname(current);
	} catch {
		return undefined;
	}
	for (;;) {
		try {
			await stat(path.join(current, ".git"));
			return current;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

async function ignoreContext(directory: string): Promise<IgnoreContext | undefined> {
	const paths = [path.join(directory, ".gitignore"), path.join(directory, ".ignore")];
	const metadata = await Promise.all(
		paths.map(async (filePath) => {
			try {
				const value = await stat(filePath);
				return { filePath, signature: `${value.mtimeMs}:${value.size}` };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		}),
	);
	const existing = metadata.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
	const signature = existing.map((entry) => `${entry.filePath}:${entry.signature}`).join("|");
	const cached = ignoreCache.get(directory);
	if (cached?.signature === signature) return cached.context;

	const sources = await Promise.all(existing.map((entry) => readFile(entry.filePath, "utf8")));
	const context = sources.length === 0 ? undefined : { basePath: directory, matcher: createIgnore().add(sources) };
	ignoreCache.delete(directory);
	ignoreCache.set(directory, { signature, context });
	if (ignoreCache.size > MAX_IGNORE_CACHE_ENTRIES) {
		const oldest = ignoreCache.keys().next().value;
		if (oldest !== undefined) ignoreCache.delete(oldest);
	}
	return context;
}

async function initialIgnoreContexts(searchPath: string): Promise<IgnoreContext[]> {
	const root = (await existingGitRoot(searchPath)) ?? searchPath;
	const directories: string[] = [];
	let current = root;
	directories.push(current);
	while (current !== searchPath) {
		const relative = path.relative(current, searchPath);
		const [next] = relative.split(path.sep);
		if (!next) break;
		current = path.join(current, next);
		directories.push(current);
	}
	const contexts = await Promise.all(directories.map((directory) => ignoreContext(directory)));
	return contexts.filter((context): context is IgnoreContext => context !== undefined);
}

function isIgnored(candidate: string, isDirectory: boolean, contexts: readonly IgnoreContext[]): boolean {
	let ignored = false;
	for (const context of contexts) {
		const relative = path.relative(context.basePath, candidate);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		const value = `${normalizeRelative(relative)}${isDirectory ? "/" : ""}`;
		const result = context.matcher.test(value);
		if (result.ignored) ignored = true;
		if (result.unignored) ignored = false;
	}
	return ignored;
}

function compilePattern(pattern: string | undefined): Minimatch | undefined {
	if (pattern === undefined) return undefined;
	try {
		let bracketDepth = 0;
		for (let index = 0; index < pattern.length; index++) {
			if (pattern[index] === "\\") {
				index++;
				continue;
			}
			if (pattern[index] === "[") bracketDepth++;
			if (pattern[index] === "]") bracketDepth--;
			if (bracketDepth < 0) throw new Error("unmatched closing bracket");
		}
		if (bracketDepth !== 0) throw new Error("unmatched opening bracket");
		const matcher = new Minimatch(pattern, {
			dot: true,
			matchBase: !pattern.includes("/"),
			nocase: process.platform === "win32",
		});
		if (!matcher.makeRe()) throw new Error("could not compile the glob");
		return matcher;
	} catch (error) {
		throw new Error(`error parsing glob: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function walkNativeFiles(searchPath: string, options: NativeWalkOptions = {}): Promise<NativeFileEntry[]> {
	const searchStat = await stat(searchPath);
	if (!searchStat.isDirectory()) {
		return [{ absolutePath: searchPath, relativePath: path.basename(searchPath), isDirectory: false }];
	}
	const matcher = compilePattern(options.pattern);
	const limit = Math.max(1, options.limit ?? Number.MAX_SAFE_INTEGER);
	const results: NativeFileEntry[] = [];
	let walkedEntries = 0;
	const inherited = (await initialIgnoreContexts(searchPath)).filter((context) => context.basePath !== searchPath);
	let frontier: Array<{ directory: string; inherited: readonly IgnoreContext[] }> = [
		{ directory: searchPath, inherited },
	];

	while (frontier.length > 0 && results.length < limit) {
		const scans: Array<
			| {
					directory: string;
					contexts: readonly IgnoreContext[];
					entries: Dirent[];
			  }
			| undefined
		> = new Array(frontier.length);
		let scanIndex = 0;
		await Promise.all(
			Array.from({ length: Math.min(MAX_DIRECTORY_CONCURRENCY, frontier.length) }, async () => {
				for (;;) {
					const index = scanIndex++;
					if (index >= frontier.length) return;
					if (options.signal?.aborted) throw new Error("Operation aborted");
					const current = frontier[index];
					if (!current) return;
					const local = await ignoreContext(current.directory);
					const contexts = local ? [...current.inherited, local] : current.inherited;
					const entries = await readdir(current.directory, { withFileTypes: true });
					entries.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
					scans[index] = { directory: current.directory, contexts, entries };
				}
			}),
		);

		const nextFrontier: typeof frontier = [];
		for (const scan of scans) {
			if (!scan) continue;
			for (const entry of scan.entries) {
				if (options.signal?.aborted) throw new Error("Operation aborted");
				if (++walkedEntries > MAX_WALKED_ENTRIES) {
					throw new Error(`Native file search exceeded ${MAX_WALKED_ENTRIES} entries; narrow path.`);
				}
				if (entry.name === ".git" && entry.isDirectory()) continue;
				const absolutePath = path.join(scan.directory, entry.name);
				const directoryEntry = entry.isDirectory();
				if (isIgnored(absolutePath, directoryEntry, scan.contexts)) continue;
				const relativePath = normalizeRelative(path.relative(searchPath, absolutePath));
				const displayPath = `${relativePath}${directoryEntry ? "/" : ""}`;
				if (!matcher || matcher.match(relativePath) || (directoryEntry && matcher.match(displayPath))) {
					results.push({ absolutePath, relativePath: displayPath, isDirectory: directoryEntry });
					if (results.length >= limit) return results;
				}
				if (directoryEntry && !entry.isSymbolicLink()) {
					nextFrontier.push({ directory: absolutePath, inherited: scan.contexts });
				}
			}
		}
		frontier = nextFrontier;
	}
	return results;
}
