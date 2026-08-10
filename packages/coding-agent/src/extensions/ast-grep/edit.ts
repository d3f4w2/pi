import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pattern as compilePattern, type NapiConfig, parseAsync, type SgNode } from "@ast-grep/napi";
import { createFileDiff } from "../../core/tools/edit-diff.ts";
import type { LanguageConfig } from "./languages.ts";
import { expandMarkdownReplacement, findMarkdownMatches } from "./markdown.ts";
import { collectFiles, configForFile, resolveSearchTarget } from "./search.ts";
import type { AstEditDetails, AstEditRequest, AstEditResult, AstGrepExplicitLanguage } from "./types.ts";

const DEFAULT_MAX_MATCHES = 100;
const MAX_CHANGED_FILES = 100;
const MAX_CACHED_PREVIEWS = 20;
const TIMEOUT_MS = 20_000;

interface PreparedFileEdit {
	absolutePath: string;
	displayPath: string;
	originalContent: string;
	newContent: string;
	revision: string;
	matchCount: number;
}

export interface AstEditPlan {
	files: PreparedFileEdit[];
	details: AstEditDetails;
}

export interface AstEditServiceOptions {
	replaceFile?: (filePath: string, content: string) => Promise<void>;
}

function fileRevision(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function sliceByByteRange(source: string, start: number, end: number): string {
	return Buffer.from(source).subarray(start, end).toString("utf8");
}

function expandReplacement(node: SgNode, replacement: string, source: string): string {
	return replacement.replace(/\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g, (placeholder, multi, single) => {
		const name = (multi ?? single) as string;
		if (multi !== undefined) {
			const matches = node.getMultipleMatches(name);
			if (matches.length === 0) throw new Error(`替换模板中的 ${placeholder} 没有对应的捕获内容。`);
			const first = matches[0].range();
			const last = matches[matches.length - 1].range();
			return sliceByByteRange(source, first.start.index, last.end.index);
		}
		const match = node.getMatch(name);
		if (!match) throw new Error(`替换模板中的 ${placeholder} 没有对应的捕获内容。`);
		return match.text();
	});
}

function projectPath(projectRoot: string, filePath: string): string {
	return path.relative(projectRoot, filePath).replaceAll("\\", "/") || path.basename(filePath);
}

function commitMarkdownEdits(source: string, pattern: string, replacement: string): { content: string; count: number } {
	const matches = findMarkdownMatches(source, pattern);
	for (let index = 1; index < matches.length; index++) {
		if (matches[index - 1].endOffset > matches[index].startOffset) {
			throw new Error("ast_edit 找到重叠的 Markdown 结构，未修改任何文件。");
		}
	}
	let content = source;
	for (const match of matches.slice().reverse()) {
		content = `${content.slice(0, match.startOffset)}${expandMarkdownReplacement(match, replacement)}${content.slice(match.endOffset)}`;
	}
	return { content, count: matches.length };
}

async function prepareFile(
	filePath: string,
	projectRoot: string,
	config: LanguageConfig,
	matcher: NapiConfig | undefined,
	request: AstEditRequest,
): Promise<PreparedFileEdit | undefined> {
	const originalContent = await readFile(filePath, "utf8");
	let newContent: string;
	let matchCount: number;
	if (config.engine === "markdown") {
		const result = commitMarkdownEdits(originalContent, request.pattern, request.replacement);
		newContent = result.content;
		matchCount = result.count;
	} else {
		if (!config.lang || !matcher) throw new Error(`ast_edit 缺少 ${config.id} 解析器。`);
		const root = await parseAsync(config.lang, originalContent);
		const nodes = root.root().findAll(matcher);
		if (nodes.length === 0) return undefined;
		const edits = nodes.map((node) => node.replace(expandReplacement(node, request.replacement, originalContent)));
		edits.sort((left, right) => left.startPos - right.startPos);
		for (let index = 1; index < edits.length; index++) {
			if (edits[index - 1].endPos > edits[index].startPos) {
				throw new Error(`ast_edit 在 ${projectPath(projectRoot, filePath)} 找到重叠结构，未修改任何文件。`);
			}
		}
		newContent = root.root().commitEdits(edits);
		matchCount = nodes.length;
	}
	if (newContent === originalContent) return undefined;
	config.validate?.(newContent);
	return {
		absolutePath: filePath,
		displayPath: projectPath(projectRoot, filePath),
		originalContent,
		newContent,
		revision: fileRevision(originalContent),
		matchCount,
	};
}

async function atomicReplace(filePath: string, content: string): Promise<void> {
	const fileStat = await stat(filePath);
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.pi-ast-edit-${process.pid}-${randomUUID()}.tmp`,
	);
	let committed = false;
	try {
		await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: fileStat.mode });
		await chmod(tempPath, fileStat.mode);
		await rename(tempPath, filePath);
		committed = true;
	} finally {
		if (!committed) {
			try {
				await unlink(tempPath);
			} catch {}
		}
	}
}

function previewKey(request: AstEditRequest, cwd: string): string {
	return JSON.stringify([
		path.resolve(cwd),
		request.pattern,
		request.replacement,
		request.language,
		request.path?.trim() || ".",
		request.maxMatches ?? DEFAULT_MAX_MATCHES,
	]);
}

export interface AstEditServiceLike {
	preview(request: AstEditRequest, cwd: string, signal?: AbortSignal): Promise<AstEditResult>;
	edit(request: AstEditRequest, cwd: string, signal?: AbortSignal): Promise<AstEditResult>;
}

export class AstEditService implements AstEditServiceLike {
	private readonly previews = new Map<string, AstEditPlan>();
	private readonly replaceFile: (filePath: string, content: string) => Promise<void>;

	constructor(options: AstEditServiceOptions = {}) {
		this.replaceFile = options.replaceFile ?? atomicReplace;
	}

	async preparePlan(request: AstEditRequest, cwd: string, signal?: AbortSignal): Promise<AstEditPlan> {
		const startedAt = Date.now();
		const requestedPath = request.path?.trim() || ".";
		const maxMatches = request.maxMatches ?? DEFAULT_MAX_MATCHES;
		const timeoutController = new AbortController();
		const timeout = setTimeout(() => timeoutController.abort(new Error("timeout")), TIMEOUT_MS);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
		try {
			const { projectRoot, target } = await resolveSearchTarget(cwd, requestedPath);
			const { files } = await collectFiles(target, request.language, combinedSignal);
			const matchers = new Map<AstGrepExplicitLanguage, NapiConfig>();
			const preparedFiles: PreparedFileEdit[] = [];
			let matchCount = 0;

			for (const filePath of files) {
				if (combinedSignal.aborted) throw combinedSignal.reason;
				const config = configForFile(filePath, request.language);
				if (!config) continue;
				let matcher: NapiConfig | undefined;
				if (config.engine === "napi") {
					if (!config.lang) throw new Error(`ast_edit 缺少 ${config.id} 解析器。`);
					matcher = matchers.get(config.id);
					if (!matcher) {
						matcher = compilePattern(config.lang, request.pattern);
						matchers.set(config.id, matcher);
					}
				}
				const prepared = await prepareFile(filePath, projectRoot, config, matcher, request);
				if (!prepared) continue;
				matchCount += prepared.matchCount;
				if (matchCount > maxMatches) {
					throw new Error(
						`ast_edit 匹配超过 ${maxMatches} 处，已停止且未修改文件；请缩小 path 或提高 max_matches。`,
					);
				}
				preparedFiles.push(prepared);
				if (preparedFiles.length > MAX_CHANGED_FILES) {
					throw new Error(`ast_edit 将修改超过 ${MAX_CHANGED_FILES} 个文件，已停止且未写入。请缩小 path。`);
				}
			}

			if (preparedFiles.length === 0) throw new Error("ast_edit 没有找到可修改的代码结构，未写入任何文件。");
			const diffs = preparedFiles.map((file) =>
				createFileDiff(file.displayPath, file.originalContent, file.newContent),
			);
			const details: AstEditDetails = {
				language: request.language,
				path: requestedPath,
				changedFileCount: preparedFiles.length,
				changedFiles: diffs.map((diff) => diff.path),
				matchCount,
				additions: diffs.reduce((total, diff) => total + diff.additions, 0),
				deletions: diffs.reduce((total, diff) => total + diff.deletions, 0),
				durationMs: Date.now() - startedAt,
				diffs,
			};
			return { files: preparedFiles, details };
		} catch (error) {
			if (timeoutController.signal.aborted && !signal?.aborted) {
				throw new Error("ast_edit 准备变更超过 20 秒，已停止且未修改文件；请缩小 path。");
			}
			if (signal?.aborted) throw new Error("ast_edit 已取消，未修改文件。");
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	async applyPlan(plan: AstEditPlan, signal?: AbortSignal): Promise<void> {
		for (const file of plan.files) {
			if (signal?.aborted) throw new Error("ast_edit 已取消，未修改文件。");
			const current = await readFile(file.absolutePath, "utf8");
			if (fileRevision(current) !== file.revision) {
				throw new Error(`${file.displayPath} 在预览后发生变化，ast_edit 已停止且未修改文件。`);
			}
		}

		const committed: PreparedFileEdit[] = [];
		try {
			for (const file of plan.files) {
				if (signal?.aborted) throw new Error("ast_edit 已取消。");
				await this.replaceFile(file.absolutePath, file.newContent);
				committed.push(file);
			}
		} catch (error) {
			const rollbackFailures: string[] = [];
			for (const file of committed.slice().reverse()) {
				try {
					await this.replaceFile(file.absolutePath, file.originalContent);
				} catch {
					rollbackFailures.push(file.displayPath);
				}
			}
			const reason = error instanceof Error ? error.message : String(error);
			if (rollbackFailures.length > 0) {
				throw new Error(`ast_edit 写入失败：${reason}；以下文件回滚失败：${rollbackFailures.join(", ")}`);
			}
			throw new Error(`ast_edit 写入失败，已回滚全部变更：${reason}`);
		}
	}

	async preview(request: AstEditRequest, cwd: string, signal?: AbortSignal): Promise<AstEditResult> {
		const plan = await this.preparePlan(request, cwd, signal);
		const key = previewKey(request, cwd);
		this.previews.delete(key);
		this.previews.set(key, plan);
		while (this.previews.size > MAX_CACHED_PREVIEWS) {
			const oldest = this.previews.keys().next().value as string | undefined;
			if (!oldest) break;
			this.previews.delete(oldest);
		}
		return {
			text: `将修改 ${plan.details.changedFileCount} 个文件中的 ${plan.details.matchCount} 处代码结构。`,
			details: plan.details,
		};
	}

	async edit(request: AstEditRequest, cwd: string, signal?: AbortSignal): Promise<AstEditResult> {
		const key = previewKey(request, cwd);
		const plan = this.previews.get(key) ?? (await this.preparePlan(request, cwd, signal));
		this.previews.delete(key);
		await this.applyPlan(plan, signal);
		return {
			text: `已修改 ${plan.details.changedFileCount} 个文件中的 ${plan.details.matchCount} 处代码结构。`,
			details: plan.details,
		};
	}
}
