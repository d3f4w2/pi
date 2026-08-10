import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { findGitPaths } from "../../core/footer-data-provider.ts";
import {
	type FileMemoryEvidence,
	MAX_MEMORY_EVIDENCE_BYTES,
	MAX_MEMORY_EVIDENCE_EXCERPT_LENGTH,
	MAX_MEMORY_EVIDENCE_FILES,
	type MemoryEvidenceInput,
	type MemoryStaleReason,
	type ProjectMemoryScope,
} from "./types.ts";

function normalizedIdentityPath(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function readBranch(headPath: string | undefined): string {
	if (!headPath) return "unversioned";
	try {
		const head = readFileSync(headPath, "utf8").trim();
		if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length) || "detached";
		return head ? `detached:${head.slice(0, 12)}` : "detached";
	} catch {
		return "unknown";
	}
}

export function resolveProjectMemoryScope(cwd: string): ProjectMemoryScope {
	const gitPaths = findGitPaths(cwd);
	const root = realpathSync(gitPaths?.repoDir ?? cwd);
	const identity = normalizedIdentityPath(gitPaths?.commonGitDir ?? root);
	return {
		type: "project",
		projectId: createHash("sha256").update(identity).digest("hex"),
		projectRoot: root,
		branch: readBranch(gitPaths?.headPath),
	};
}

function pathIsInside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeExcerpt(value: string): string {
	return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function lineRange(content: string, quote: string): { startLine?: number; endLine?: number } {
	const index = content.indexOf(quote);
	if (index < 0) return {};
	const startLine = content.slice(0, index).split(/\r?\n/u).length;
	return { startLine, endLine: startLine + quote.split(/\r?\n/u).length - 1 };
}

async function resolveEvidenceFile(
	inputPath: string,
	root: string,
): Promise<{ filePath: string; relativePath: string; size: number; content: Buffer }> {
	if (/[\p{Cc}]/u.test(inputPath)) throw new Error("证据路径包含不安全的控制字符");
	const requestedPath = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
	let filePath: string;
	try {
		filePath = await realpath(requestedPath);
	} catch {
		throw new Error(`证据文件不存在：${inputPath}`);
	}
	if (!pathIsInside(root, filePath)) throw new Error(`证据文件位于项目目录之外：${inputPath}`);
	const fileStat = await stat(filePath);
	if (!fileStat.isFile()) throw new Error(`证据路径不是文件：${inputPath}`);
	if (fileStat.size > MAX_MEMORY_EVIDENCE_BYTES) {
		throw new Error(`证据文件超过 ${MAX_MEMORY_EVIDENCE_BYTES / 1024 / 1024} MB：${inputPath}`);
	}
	const relativePath = relative(root, filePath).replaceAll("\\", "/");
	if (/[\p{Cc}]/u.test(relativePath)) throw new Error("证据路径包含不安全的控制字符");
	return { filePath, relativePath, size: fileStat.size, content: await readFile(filePath) };
}

export async function captureFileEvidence(
	inputs: readonly MemoryEvidenceInput[],
	scope: ProjectMemoryScope,
	now: () => Date,
): Promise<FileMemoryEvidence[]> {
	if (inputs.length === 0) throw new Error("项目、经历或方法记忆至少需要一个证据文件");
	if (inputs.length > MAX_MEMORY_EVIDENCE_FILES) {
		throw new Error(`一条记忆最多绑定 ${MAX_MEMORY_EVIDENCE_FILES} 个证据文件`);
	}
	const root = await realpath(scope.projectRoot);
	const evidence: FileMemoryEvidence[] = [];
	for (const input of inputs) {
		const resolved = await resolveEvidenceFile(input.path, root);
		const text = resolved.content.toString("utf8");
		const quote = input.quote?.trim();
		if (quote) {
			const excerpt = normalizeExcerpt(quote);
			if (excerpt.length < 8) throw new Error(`证据引用太短，无法可靠定位：${input.path}`);
			if (excerpt.length > MAX_MEMORY_EVIDENCE_EXCERPT_LENGTH) {
				throw new Error(`证据引用最多 ${MAX_MEMORY_EVIDENCE_EXCERPT_LENGTH} 个字符：${input.path}`);
			}
			if (!normalizeExcerpt(text).includes(excerpt)) throw new Error(`证据引用不在文件中：${input.path}`);
			evidence.push({
				type: "file",
				path: resolved.relativePath,
				mode: "excerpt",
				digest: createHash("sha256").update(excerpt).digest("hex"),
				excerpt,
				...lineRange(text, quote),
				size: resolved.size,
				capturedAt: now().toISOString(),
			});
			continue;
		}
		evidence.push({
			type: "file",
			path: resolved.relativePath,
			mode: "file",
			digest: createHash("sha256").update(resolved.content).digest("hex"),
			size: resolved.size,
			capturedAt: now().toISOString(),
		});
	}
	return evidence;
}

export async function validateFileEvidence(
	evidence: readonly FileMemoryEvidence[],
	scope: ProjectMemoryScope,
): Promise<MemoryStaleReason | undefined> {
	for (const item of evidence) {
		const filePath = resolve(scope.projectRoot, item.path);
		let content: Buffer;
		try {
			const canonicalRoot = await realpath(scope.projectRoot);
			const canonicalFile = await realpath(filePath);
			if (!pathIsInside(canonicalRoot, canonicalFile)) return "evidence_unreadable";
			const fileStat = await stat(canonicalFile);
			if (!fileStat.isFile() || fileStat.size > MAX_MEMORY_EVIDENCE_BYTES) return "evidence_unreadable";
			content = await readFile(canonicalFile);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "evidence_missing" : "evidence_unreadable";
		}
		if (item.mode === "excerpt" && item.excerpt) {
			const excerpt = normalizeExcerpt(item.excerpt);
			if (createHash("sha256").update(excerpt).digest("hex") !== item.digest) return "evidence_unreadable";
			if (!normalizeExcerpt(content.toString("utf8")).includes(excerpt)) return "evidence_changed";
			continue;
		}
		if (createHash("sha256").update(content).digest("hex") !== item.digest) return "evidence_changed";
	}
	return undefined;
}
