import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pattern as compilePattern, type NapiConfig, parseAsync, type SgNode } from "@ast-grep/napi";
import { createFileDiff } from "../../core/tools/edit-diff.ts";
import { collectFiles, configForFile, resolveSearchTarget } from "./search.ts";
import type { AstEditDetails, AstEditRequest, AstEditResult, AstGrepExplicitLanguage } from "./types.ts";

const DEFAULT_MAX_MATCHES = 100;
const MAX_CHANGED_FILES = 100;
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

async function prepareFile(
	filePath: string,
	projectRoot: string,
	matcher: NapiConfig,
	request: AstEditRequest,
): Promise<PreparedFileEdit | undefined> {
	const config = configForFile(filePath, request.language);
	if (!config) return undefined;
	const originalContent = await readFile(filePath, "utf8");
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
	const newContent = root.root().commitEdits(edits);
	if (newContent === originalContent) return undefined;
	return {
		absolutePath: filePath,
		displayPath: projectPath(projectRoot, filePath),
		originalContent,
		newContent,
		revision: fileRevision(originalContent),
		matchCount: nodes.length,
	};
}

async function atomicReplace(file: PreparedFileEdit, content: string): Promise<void> {
	const fileStat = await stat(file.absolutePath);
	const tempPath = path.join(
		path.dirname(file.absolutePath),
		`.${path.basename(file.absolutePath)}.pi-ast-edit-${process.pid}-${randomUUID()}.tmp`,
	);
	let committed = false;
	try {
		await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: fileStat.mode });
		await chmod(tempPath, fileStat.mode);
		await rename(tempPath, file.absolutePath);
		committed = true;
	} finally {
		if (!committed) {
			try {
				await unlink(tempPath);
			} catch {}
		}
	}
}

export interface AstEditServiceLike {
	preview(request: AstEditRequest, cwd: string, signal?: AbortSignal): Promise<AstEditResult>;
	edit(request: AstEditRequest, cwd: string, signal?: AbortSignal): Promise<AstEditResult>;
}

export class AstEditService implements AstEditServiceLike {
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
				let matcher = matchers.get(config.id);
				if (!matcher) {
					matcher = compilePattern(config.lang, request.pattern);
					matchers.set(config.id, matcher);
				}
				const prepared = await prepareFile(filePath, projectRoot, matcher, request);
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
				await atomicReplace(file, file.newContent);
				committed.push(file);
			}
		} catch (error) {
			const rollbackFailures: string[] = [];
			for (const file of committed.reverse()) {
				try {
					await atomicReplace(file, file.originalContent);
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
		return {
			text: `将修改 ${plan.details.changedFileCount} 个文件中的 ${plan.details.matchCount} 处代码结构。`,
			details: plan.details,
		};
	}

	async edit(request: AstEditRequest, cwd: string, signal?: AbortSignal): Promise<AstEditResult> {
		const plan = await this.preparePlan(request, cwd, signal);
		await this.applyPlan(plan, signal);
		return {
			text: `已修改 ${plan.details.changedFileCount} 个文件中的 ${plan.details.matchCount} 处代码结构。`,
			details: plan.details,
		};
	}
}
