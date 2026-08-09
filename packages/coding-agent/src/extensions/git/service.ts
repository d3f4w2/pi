import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createFileDiff } from "../../core/tools/edit-diff.ts";
import { DirectGitCommandRunner } from "./process.ts";
import type {
	GitChangedFile,
	GitCommandResult,
	GitCommandRunner,
	GitDiffScope,
	GitLogEntry,
	GitOverview,
} from "./types.ts";

const DEFAULT_MAX_FILES = 200;
const MAX_FILES = 1000;
const MAX_DIFF_BYTES = 1_000_000;
const MAX_LOG_ENTRIES = 50;

function gitError(result: GitCommandResult): string {
	return (result.stderr || result.stdout || `Git 退出码 ${result.code}`).replace(/\s+/g, " ").trim().slice(0, 500);
}

function splitFixedFields(record: string, fixedCount: number): { fields: string[]; rest: string } {
	const fields: string[] = [];
	let offset = 0;
	for (let index = 0; index < fixedCount; index++) {
		const separator = record.indexOf(" ", offset);
		if (separator < 0) return { fields, rest: "" };
		fields.push(record.slice(offset, separator));
		offset = separator + 1;
	}
	return { fields, rest: record.slice(offset) };
}

function changedFile(
	pathValue: string,
	xy: string,
	options: { originalPath?: string; untracked?: boolean; conflicted?: boolean } = {},
): GitChangedFile {
	const indexStatus = options.untracked ? "?" : (xy[0] ?? ".");
	const worktreeStatus = options.untracked ? "?" : (xy[1] ?? ".");
	return {
		path: pathValue,
		...(options.originalPath === undefined ? {} : { originalPath: options.originalPath }),
		indexStatus,
		worktreeStatus,
		staged: indexStatus !== "." && indexStatus !== "?",
		unstaged: worktreeStatus !== "." || options.untracked === true,
		untracked: options.untracked === true,
		conflicted: options.conflicted === true,
	};
}

export function parseGitStatus(output: string, repositoryRoot: string, maxFiles = DEFAULT_MAX_FILES): GitOverview {
	const records = output.split("\0");
	let branch = "(detached)";
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	const files: GitChangedFile[] = [];
	let truncated = false;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith("# branch.head ")) {
			branch = record.slice(14);
			continue;
		}
		if (record.startsWith("# branch.upstream ")) {
			upstream = record.slice(18);
			continue;
		}
		if (record.startsWith("# branch.ab ")) {
			const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/);
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
			continue;
		}
		if (/^[?12u] /.test(record) && files.length >= maxFiles) {
			truncated = true;
			if (record.startsWith("2 ")) index++;
			continue;
		}
		if (record.startsWith("? ")) {
			files.push(changedFile(record.slice(2), "??", { untracked: true }));
			continue;
		}
		if (record.startsWith("1 ")) {
			const parsed = splitFixedFields(record, 8);
			if (parsed.fields.length === 8) files.push(changedFile(parsed.rest, parsed.fields[1] ?? ".."));
			continue;
		}
		if (record.startsWith("2 ")) {
			const parsed = splitFixedFields(record, 9);
			const originalPath = records[index + 1];
			if (parsed.fields.length === 9 && originalPath !== undefined) {
				files.push(changedFile(parsed.rest, parsed.fields[1] ?? "..", { originalPath }));
				index++;
			}
			continue;
		}
		if (record.startsWith("u ")) {
			const parsed = splitFixedFields(record, 10);
			if (parsed.fields.length === 10) {
				files.push(changedFile(parsed.rest, parsed.fields[1] ?? "UU", { conflicted: true }));
			}
		}
	}
	return {
		repositoryRoot,
		branch,
		...(upstream === undefined ? {} : { upstream }),
		ahead,
		behind,
		files,
		truncated,
	};
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRepoPath(root: string, input: string): string {
	const absolute = path.resolve(root, input);
	if (!isInside(root, absolute)) throw new Error(`Git 路径不在当前仓库中：${input}`);
	return path.relative(root, absolute).replaceAll("\\", "/");
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	const a = [...new Set(left)].sort();
	const b = [...new Set(right)].sort();
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function formatOverview(overview: GitOverview): string {
	const relation = overview.upstream
		? ` · ${overview.upstream} · 领先 ${overview.ahead} / 落后 ${overview.behind}`
		: "";
	const lines = [`分支：${overview.branch}${relation}`, `变更：${overview.files.length} 个文件`];
	for (const file of overview.files) {
		const state = file.conflicted
			? "冲突"
			: file.untracked
				? "未跟踪"
				: file.staged && file.unstaged
					? "已暂存+又修改"
					: file.staged
						? "已暂存"
						: "未暂存";
		lines.push(`${state} ${file.path}${file.originalPath ? ` <- ${file.originalPath}` : ""}`);
	}
	if (overview.truncated) lines.push("文件较多，结果已截断。请缩小操作范围。");
	return lines.join("\n");
}

export class GitService {
	private readonly runner: GitCommandRunner;

	constructor(runner: GitCommandRunner = new DirectGitCommandRunner()) {
		this.runner = runner;
	}

	private async command(
		args: readonly string[],
		cwd: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<GitCommandResult> {
		const result = await this.runner.run(args, cwd, { signal, timeoutMs });
		if (result.code !== 0) throw new Error(gitError(result));
		if (result.truncated) throw new Error("Git 输出超过安全上限，已停止。请缩小操作范围。");
		return result;
	}

	async repositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
		const result = await this.command(["rev-parse", "--show-toplevel"], cwd, signal);
		return path.resolve(result.stdout.trim());
	}

	async overview(
		cwd: string,
		signal?: AbortSignal,
		maxFiles = DEFAULT_MAX_FILES,
	): Promise<{ text: string; overview: GitOverview }> {
		const root = await this.repositoryRoot(cwd, signal);
		const result = await this.command(
			["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
			root,
			signal,
		);
		const overview = parseGitStatus(result.stdout, root, Math.min(Math.max(1, maxFiles), MAX_FILES));
		return { text: formatOverview(overview), overview };
	}

	private async gitBlob(root: string, spec: string, signal?: AbortSignal): Promise<string | null> {
		const result = await this.runner.run(["show", spec], root, { signal, timeoutMs: 15_000 });
		if (result.code !== 0) return null;
		if (result.truncated || Buffer.byteLength(result.stdout) > MAX_DIFF_BYTES) {
			throw new Error("文件超过 1 MB，Diff 预览已停止。请缩小文件或使用普通 Git 查看。");
		}
		return result.stdout;
	}

	private async worktreeFile(root: string, filePath: string): Promise<string | null> {
		const absolutePath = path.join(root, filePath);
		try {
			const fileStat = await stat(absolutePath);
			if (!fileStat.isFile()) return null;
			if (fileStat.size > MAX_DIFF_BYTES) throw new Error("文件超过 1 MB，Diff 预览已停止。");
			return await readFile(absolutePath, "utf8");
		} catch (error: unknown) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		}
	}

	async diff(
		cwd: string,
		filePath: string,
		scope: GitDiffScope = "all",
		signal?: AbortSignal,
	): Promise<{ text: string; file: GitChangedFile; diff: ReturnType<typeof createFileDiff> }> {
		const { overview } = await this.overview(cwd, signal, MAX_FILES);
		const normalizedPath = normalizeRepoPath(overview.repositoryRoot, filePath);
		const file = overview.files.find((candidate) => candidate.path === normalizedPath);
		if (!file) throw new Error(`当前变更中没有这个文件：${filePath}`);
		if (file.conflicted) throw new Error("冲突文件暂不提供结构化 Diff，请先处理冲突。");
		if (scope === "staged" && !file.staged) throw new Error(`${normalizedPath} 没有已暂存变更。`);
		if (scope === "worktree" && !file.unstaged) throw new Error(`${normalizedPath} 没有未暂存变更。`);
		const root = overview.repositoryRoot;
		const oldContent =
			scope === "worktree"
				? await this.gitBlob(root, `:${normalizedPath}`, signal)
				: await this.gitBlob(root, `HEAD:${file.originalPath ?? normalizedPath}`, signal);
		const newContent =
			scope === "staged"
				? await this.gitBlob(root, `:${normalizedPath}`, signal)
				: await this.worktreeFile(root, normalizedPath);
		if (oldContent?.includes("\0") || newContent?.includes("\0")) throw new Error("二进制文件不显示文本 Diff。");
		const diff = createFileDiff(normalizedPath, oldContent, newContent);
		return {
			text: `${normalizedPath} · +${diff.additions} -${diff.deletions}\n${diff.diff}`,
			file,
			diff,
		};
	}

	async log(cwd: string, signal?: AbortSignal, maxCount = 10): Promise<{ text: string; entries: GitLogEntry[] }> {
		const root = await this.repositoryRoot(cwd, signal);
		const count = Math.min(Math.max(1, maxCount), MAX_LOG_ENTRIES);
		const result = await this.command(
			["log", `--max-count=${count}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e"],
			root,
			signal,
		);
		const entries = result.stdout
			.split("\x1e")
			.map((record) => record.trim())
			.filter(Boolean)
			.map((record) => {
				const [hash = "", shortHash = "", author = "", date = "", subject = ""] = record.split("\x1f");
				return { hash, shortHash, author, date, subject };
			});
		return {
			text:
				entries.map((entry) => `${entry.shortHash} ${entry.subject} · ${entry.author}`).join("\n") || "暂无提交。",
			entries,
		};
	}

	private validatePaths(overview: GitOverview, paths: readonly string[], mode: "changed" | "staged"): string[] {
		if (paths.length === 0) throw new Error("至少需要指定一个文件。");
		if (overview.truncated) throw new Error("仓库变更超过安全上限，无法完整核对文件。请先缩小变更范围。");
		const normalized = [...new Set(paths.map((filePath) => normalizeRepoPath(overview.repositoryRoot, filePath)))];
		for (const filePath of normalized) {
			const file = overview.files.find((candidate) => candidate.path === filePath);
			if (!file || (mode === "staged" && !file.staged)) {
				throw new Error(mode === "staged" ? `文件没有已暂存变更：${filePath}` : `文件不在当前变更中：${filePath}`);
			}
		}
		return normalized;
	}

	async stage(
		cwd: string,
		paths: readonly string[],
		signal?: AbortSignal,
	): Promise<{ text: string; paths: string[]; overview: GitOverview }> {
		const current = await this.overview(cwd, signal, MAX_FILES);
		const normalized = this.validatePaths(current.overview, paths, "changed");
		await this.command(["add", "--", ...normalized], current.overview.repositoryRoot, signal, 30_000);
		const next = await this.overview(current.overview.repositoryRoot, signal, MAX_FILES);
		return {
			text: `已暂存 ${normalized.length} 个文件：${normalized.join("、")}`,
			paths: normalized,
			overview: next.overview,
		};
	}

	async unstage(
		cwd: string,
		paths: readonly string[],
		signal?: AbortSignal,
	): Promise<{ text: string; paths: string[]; overview: GitOverview }> {
		const current = await this.overview(cwd, signal, MAX_FILES);
		const normalized = this.validatePaths(current.overview, paths, "staged");
		await this.command(["restore", "--staged", "--", ...normalized], current.overview.repositoryRoot, signal, 30_000);
		const next = await this.overview(current.overview.repositoryRoot, signal, MAX_FILES);
		return {
			text: `已取消暂存 ${normalized.length} 个文件：${normalized.join("、")}`,
			paths: normalized,
			overview: next.overview,
		};
	}

	async commit(
		cwd: string,
		message: string,
		paths: readonly string[],
		signal?: AbortSignal,
	): Promise<{ text: string; hash: string; paths: string[] }> {
		const cleanMessage = message.trim();
		if (!cleanMessage) throw new Error("提交信息不能为空。");
		const current = await this.overview(cwd, signal, MAX_FILES);
		const normalized = this.validatePaths(current.overview, paths, "staged");
		const stagedPaths = current.overview.files.filter((file) => file.staged).map((file) => file.path);
		if (!samePaths(normalized, stagedPaths)) {
			throw new Error(`提交文件必须与当前暂存区完全一致。当前暂存：${stagedPaths.join("、") || "无"}`);
		}
		await this.command(["commit", "-m", cleanMessage], current.overview.repositoryRoot, signal, 120_000);
		const hash = (await this.command(["rev-parse", "HEAD"], current.overview.repositoryRoot, signal)).stdout.trim();
		return { text: `已提交 ${hash.slice(0, 8)}：${cleanMessage}`, hash, paths: normalized };
	}

	async push(
		cwd: string,
		options: { remote?: string; branch?: string; setUpstream?: boolean } = {},
		signal?: AbortSignal,
	): Promise<{ text: string; output: string }> {
		const root = await this.repositoryRoot(cwd, signal);
		if (options.branch !== undefined && options.remote === undefined)
			throw new Error("指定分支时必须同时指定远程仓库。");
		if (options.setUpstream && (options.remote === undefined || options.branch === undefined)) {
			throw new Error("设置上游分支时必须同时指定远程仓库和分支。");
		}
		const args = ["push"];
		if (options.remote !== undefined) {
			if (!/^[A-Za-z0-9._-]+$/.test(options.remote)) throw new Error(`无效的远程仓库名称：${options.remote}`);
			const remotes = (await this.command(["remote"], root, signal)).stdout.split(/\r?\n/).filter(Boolean);
			if (!remotes.includes(options.remote)) throw new Error(`远程仓库不存在：${options.remote}`);
			if (options.branch !== undefined) {
				await this.command(["check-ref-format", "--branch", options.branch], root, signal);
				if (options.setUpstream) args.push("--set-upstream");
				args.push(options.remote, options.branch);
			} else {
				args.push(options.remote);
			}
		}
		const result = await this.command(args, root, signal, 120_000);
		const output = (result.stdout || result.stderr || "推送完成。").trim();
		return { text: output, output };
	}
}
