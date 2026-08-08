import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { truncateHead } from "../../core/tools/truncate.ts";
import { defaultMgrepOperations, MgrepProcessError } from "./process.ts";
import type {
	CodeSearchInput,
	CodeSearchProgress,
	CodeSearchResult,
	MgrepOperations,
	MgrepWatchHandle,
} from "./types.ts";

const DEFAULT_MAX_RESULTS = 6;
const MAX_RESULTS = 20;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_LINES = 200;
const DEFAULT_FOREGROUND_WAIT_MS = 2000;

export async function resolveProjectSearchPath(cwd: string, requestedPath = "."): Promise<string> {
	const projectRoot = await realpath(cwd);
	let searchPath: string;
	try {
		searchPath = await realpath(path.resolve(projectRoot, requestedPath));
	} catch {
		throw new Error(`搜索路径不存在：${requestedPath}`);
	}
	const relative = path.relative(projectRoot, searchPath);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("code_search 只能搜索和上传当前项目中的文件。");
	}
	return searchPath;
}

function waitForStartup(startup: Promise<void>, waitMs: number, signal?: AbortSignal): Promise<"ready" | "pending"> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new MgrepProcessError("cancelled", "Operation aborted"));
			return;
		}
		const timeout = setTimeout(
			() => {
				finish(() => resolve("pending"));
			},
			Math.max(0, waitMs),
		);
		let settled = false;
		const cleanup = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			action();
		};
		const onAbort = (): void => {
			finish(() => reject(new MgrepProcessError("cancelled", "Operation aborted")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		startup.then(
			() => finish(() => resolve("ready")),
			(error: unknown) =>
				finish(() => reject(error instanceof Error ? error : new MgrepProcessError("failed", String(error)))),
		);
	});
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveIndexScope(searchPath: string): Promise<string> {
	return (await stat(searchPath)).isDirectory() ? searchPath : path.dirname(searchPath);
}

function normalizeMgrepPaths(output: string, projectRoot: string, indexRoot: string): string {
	const indexPrefix = path.relative(projectRoot, indexRoot).replace(/\\/g, "/");
	return output
		.split("\n")
		.map((line) => {
			if (!/^\.[\\/].+:\d+(?:-\d+)?\s/.test(line)) return line;
			const normalized = line.replace(/\\/g, "/");
			return indexPrefix ? `./${indexPrefix}/${normalized.slice(2)}` : normalized;
		})
		.join("\n");
}

interface ActiveIndex {
	indexRoot: string;
	firstIndex: boolean;
}

export interface CodeSearchServiceOptions {
	foregroundWaitMs?: number;
}

export class CodeSearchService {
	private readonly operations: MgrepOperations;
	private watcher: MgrepWatchHandle | undefined;
	private watcherRoot: string | undefined;
	private startup: Promise<void> | undefined;
	private watcherReady = false;
	private terminalFailure: MgrepProcessError | undefined;
	private readonly fileLimitFailures = new Map<string, MgrepProcessError>();
	private readonly foregroundWaitMs: number;

	constructor(operations: MgrepOperations = defaultMgrepOperations, options: CodeSearchServiceOptions = {}) {
		this.operations = operations;
		this.foregroundWaitMs = Math.max(0, options.foregroundWaitMs ?? DEFAULT_FOREGROUND_WAIT_MS);
	}

	async search(
		input: CodeSearchInput,
		cwd: string,
		signal?: AbortSignal,
		onProgress?: CodeSearchProgress,
	): Promise<CodeSearchResult> {
		const startedAt = Date.now();
		const query = input.query.trim();
		if (query.length < 2) throw new Error("代码搜索内容至少需要两个字符。");
		const projectRoot = await realpath(cwd);
		const searchPath = await resolveProjectSearchPath(projectRoot, input.path);
		const maxResults = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(input.maxResults ?? DEFAULT_MAX_RESULTS)));
		const activeIndex = await this.ensureWatcher(projectRoot, searchPath, signal, onProgress, startedAt);
		const mgrepSearchPath = path.relative(activeIndex.indexRoot, searchPath) || ".";

		onProgress?.("语义索引已就绪，正在按意思搜索代码；超过 15 秒将立即回退。", "searching", Date.now() - startedAt);
		let rawOutput: string;
		try {
			rawOutput = await this.operations.search({
				query,
				path: mgrepSearchPath,
				cwd: activeIndex.indexRoot,
				maxResults,
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			if (error instanceof MgrepProcessError && error.kind !== "cancelled") this.terminalFailure = error;
			throw error;
		}
		const normalized = normalizeMgrepPaths(rawOutput.trim(), projectRoot, activeIndex.indexRoot);
		const truncation = truncateHead(normalized, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES });
		const text = truncation.content || "没有找到相关代码。请换一种完整描述再次搜索，或使用 grep 查找准确名称。";
		const relativePath = path.relative(projectRoot, searchPath).replace(/\\/g, "/") || ".";
		const indexPath = path.relative(projectRoot, activeIndex.indexRoot).replace(/\\/g, "/") || ".";
		return {
			text: truncation.truncated ? `${text}\n\n[结果已截断，请缩小搜索范围或换一个更具体的问题。]` : text,
			details: {
				stage: "complete",
				query,
				path: relativePath,
				durationMs: Date.now() - startedAt,
				firstIndex: activeIndex.firstIndex,
				truncated: truncation.truncated,
				indexPath,
				maxFileCount: this.operations.maxFileCount,
			},
		};
	}

	stop(): void {
		this.watcher?.stop();
		this.watcher = undefined;
		this.watcherRoot = undefined;
		this.startup = undefined;
		this.watcherReady = false;
		this.terminalFailure = undefined;
		this.fileLimitFailures.clear();
	}

	private async ensureWatcher(
		projectRoot: string,
		searchPath: string,
		signal: AbortSignal | undefined,
		onProgress: CodeSearchProgress | undefined,
		startedAt: number,
	): Promise<ActiveIndex> {
		if (this.terminalFailure) throw this.terminalFailure;
		if (
			this.watcher?.isRunning() &&
			this.watcherReady &&
			this.watcherRoot &&
			isWithin(this.watcherRoot, searchPath)
		) {
			return { indexRoot: this.watcherRoot, firstIndex: false };
		}
		const deadline = Date.now() + this.foregroundWaitMs;
		if (this.watcher?.isRunning() && this.startup && this.watcherRoot && isWithin(this.watcherRoot, searchPath)) {
			const status = await waitForStartup(this.startup, deadline - Date.now(), signal);
			if (status === "ready") return { indexRoot: this.watcherRoot, firstIndex: false };
			throw new MgrepProcessError("warming", "mgrep indexing continues in the background");
		}

		const scopedRoot = await resolveIndexScope(searchPath);
		const candidateRoots = scopedRoot === projectRoot ? [projectRoot] : [projectRoot, scopedRoot];
		for (let index = 0; index < candidateRoots.length; index++) {
			const indexRoot = candidateRoots[index]!;
			const cachedFailure = this.fileLimitFailures.get(indexRoot);
			if (cachedFailure) {
				if (index < candidateRoots.length - 1) continue;
				throw cachedFailure;
			}

			try {
				const startup = this.startWatcher(indexRoot, onProgress, startedAt);
				const status = await waitForStartup(startup, deadline - Date.now(), signal);
				if (status === "ready") return { indexRoot, firstIndex: true };
				throw new MgrepProcessError("warming", "mgrep indexing continues in the background");
			} catch (error) {
				if (!(error instanceof MgrepProcessError) || error.kind !== "file-limit") throw error;
				const canNarrow = index < candidateRoots.length - 1;
				const failure = this.createFileLimitFailure(projectRoot, indexRoot, error);
				this.fileLimitFailures.set(indexRoot, failure);
				if (!canNarrow) throw failure;
				onProgress?.(
					`整个项目超过 ${this.operations.maxFileCount} 个文件，改为索引 ${path.relative(projectRoot, scopedRoot).replace(/\\/g, "/")}。`,
					"indexing",
					Date.now() - startedAt,
				);
			}
		}

		throw new Error("code_search 无法确定可用的索引范围。");
	}

	private startWatcher(
		indexRoot: string,
		onProgress: CodeSearchProgress | undefined,
		startedAt: number,
	): Promise<void> {
		this.watcher?.stop();
		this.watcherRoot = indexRoot;
		this.watcherReady = false;
		const watcher = this.operations.startWatch(
			{ cwd: indexRoot, maxFileCount: this.operations.maxFileCount },
			() => {},
		);
		this.watcher = watcher;
		onProgress?.(
			`正在后台建立语义索引，安全上限 ${this.operations.maxFileCount} 个文件；当前调用前台最多等待 2 秒。`,
			"indexing",
			Date.now() - startedAt,
		);
		let startup: Promise<void>;
		startup = watcher.ready.then(
			() => {
				if (this.watcher === watcher) this.watcherReady = true;
			},
			(error: unknown) => {
				const failure = error instanceof MgrepProcessError ? error : new MgrepProcessError("failed", String(error));
				if (failure.kind === "file-limit") this.fileLimitFailures.set(indexRoot, failure);
				else if (failure.kind !== "cancelled") this.terminalFailure = failure;
				if (this.watcher === watcher) {
					this.watcher = undefined;
					this.watcherRoot = undefined;
					this.watcherReady = false;
					if (this.startup === startup) this.startup = undefined;
				}
				throw failure;
			},
		);
		this.startup = startup;
		void startup.catch(() => {});
		return startup;
	}

	private createFileLimitFailure(projectRoot: string, indexRoot: string, error: MgrepProcessError): MgrepProcessError {
		const relativeScope = path.relative(projectRoot, indexRoot).replace(/\\/g, "/");
		const scope = relativeScope ? `范围 ${relativeScope} ` : "整个项目";
		const count = error.fileCount === undefined ? "文件数量" : `${error.fileCount} 个文件`;
		const limit = error.maxFileCount ?? this.operations.maxFileCount;
		return new MgrepProcessError(
			"file-limit",
			`code_search 已停止：${scope}需要同步 ${count}，超过安全上限 ${limit}。本次没有上传文件，且不会重复检查同一范围。请指定更小的 path，或改用内置 grep；不要通过 bash 运行 rg。`,
		);
	}
}
