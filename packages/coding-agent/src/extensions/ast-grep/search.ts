import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pattern as compilePattern, Lang, type NapiConfig, parseAsync } from "@ast-grep/napi";
import { globIterate } from "glob";
import type {
	AstGrepExplicitLanguage,
	AstGrepLanguage,
	AstGrepSearchDetails,
	AstGrepSearchRequest,
	AstGrepSearchResult,
} from "./types.ts";

const DEFAULT_MAX_RESULTS = 100;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;
const TIMEOUT_MS = 15_000;
const BATCH_SIZE = 4;
const MAX_SNIPPET_LENGTH = 180;
const SMALL_RESULT_LIMIT = 20;
const MAX_GROUPED_LINE_LENGTH = 240;
const MAX_OUTPUT_CHARACTERS = 30_000;
const IGNORED_PATHS = [
	"**/.git/**",
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"**/coverage/**",
	"**/.next/**",
	"**/out/**",
	"**/vendor/**",
];

export interface LanguageConfig {
	id: AstGrepExplicitLanguage;
	lang: Lang;
	globs: string[];
	extensions: string[];
}

const LANGUAGE_CONFIGS: Readonly<Record<AstGrepExplicitLanguage, LanguageConfig>> = {
	javascript: {
		id: "javascript",
		lang: Lang.JavaScript,
		globs: ["**/*.{js,jsx,mjs,cjs}"],
		extensions: [".js", ".jsx", ".mjs", ".cjs"],
	},
	typescript: {
		id: "typescript",
		lang: Lang.TypeScript,
		globs: ["**/*.{ts,mts,cts}"],
		extensions: [".ts", ".mts", ".cts"],
	},
	tsx: { id: "tsx", lang: Lang.Tsx, globs: ["**/*.tsx"], extensions: [".tsx"] },
	html: { id: "html", lang: Lang.Html, globs: ["**/*.{html,htm}"], extensions: [".html", ".htm"] },
	css: { id: "css", lang: Lang.Css, globs: ["**/*.css"], extensions: [".css"] },
};

export const ALL_LANGUAGE_CONFIGS = Object.values(LANGUAGE_CONFIGS);

interface FileMatch {
	filePath: string;
	line: number;
	column: number;
	text: string;
}

function isPathInside(root: string, candidate: string): boolean {
	const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
	const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function compactSnippet(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= MAX_SNIPPET_LENGTH) return compact;
	return `${compact.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

function formatPath(projectRoot: string, filePath: string): string {
	return path.relative(projectRoot, filePath).replaceAll("\\", "/") || path.basename(filePath);
}

export async function resolveSearchTarget(
	cwd: string,
	requestedPath: string,
): Promise<{ projectRoot: string; target: string }> {
	const projectRoot = await realpath(cwd);
	let target: string;
	try {
		target = await realpath(path.resolve(projectRoot, requestedPath));
	} catch {
		throw new Error(`ast_grep 找不到路径：${requestedPath}`);
	}
	if (!isPathInside(projectRoot, target)) throw new Error("ast_grep 只能搜索当前项目中的文件。");
	return { projectRoot, target };
}

export async function collectFiles(
	target: string,
	language: AstGrepLanguage,
	signal: AbortSignal,
): Promise<{ files: string[]; skippedFiles: number }> {
	const targetStat = await stat(target);
	if (targetStat.isFile()) {
		if (targetStat.size > MAX_FILE_BYTES) return { files: [], skippedFiles: 1 };
		return { files: [target], skippedFiles: 0 };
	}
	if (!targetStat.isDirectory()) throw new Error("ast_grep 的 path 必须是文件或文件夹。");

	const files: string[] = [];
	let skippedFiles = 0;
	const globs =
		language === "auto" ? ALL_LANGUAGE_CONFIGS.flatMap((config) => config.globs) : LANGUAGE_CONFIGS[language].globs;
	for await (const relativePath of globIterate(globs, {
		cwd: target,
		nodir: true,
		dot: false,
		follow: false,
		ignore: IGNORED_PATHS,
		signal,
	})) {
		if (files.length >= MAX_FILES) {
			throw new Error(`ast_grep 搜索范围超过 ${MAX_FILES} 个文件，请用 path 缩小范围。`);
		}
		const filePath = await realpath(path.resolve(target, relativePath));
		if (!isPathInside(target, filePath)) continue;
		const fileStat = await stat(filePath);
		if (fileStat.size > MAX_FILE_BYTES) {
			skippedFiles++;
			continue;
		}
		files.push(filePath);
	}
	files.sort();
	return { files, skippedFiles };
}

export function configForFile(filePath: string, language: AstGrepLanguage): LanguageConfig | undefined {
	if (language !== "auto") return LANGUAGE_CONFIGS[language];
	const extension = path.extname(filePath).toLowerCase();
	return ALL_LANGUAGE_CONFIGS.find((config) => config.extensions.includes(extension));
}

async function searchFile(filePath: string, lang: Lang, matcher: NapiConfig): Promise<FileMatch[]> {
	const source = await readFile(filePath, "utf8");
	const root = await parseAsync(lang, source);
	return root
		.root()
		.findAll(matcher)
		.map((node) => {
			const range = node.range();
			return {
				filePath,
				line: range.start.line + 1,
				column: range.start.column + 1,
				text: compactSnippet(node.text()),
			};
		});
}

function formatGroupedMatches(
	matches: readonly FileMatch[],
	projectRoot: string,
): { lines: string[]; outputTruncated: boolean } {
	const grouped = new Map<string, string[]>();
	for (const match of matches) {
		const filePath = formatPath(projectRoot, match.filePath);
		const positions = grouped.get(filePath) ?? [];
		positions.push(`${match.line}:${match.column}`);
		grouped.set(filePath, positions);
	}

	const lines = [`找到 ${matches.length} 处，分布在 ${grouped.size} 个文件：`];
	let outputLength = lines[0]?.length ?? 0;
	for (const [filePath, positions] of grouped) {
		let line = `${filePath}:`;
		for (const position of positions) {
			const next = `${line.endsWith(":") ? " " : ", "}${position}`;
			if (line.length + next.length > MAX_GROUPED_LINE_LENGTH) {
				if (outputLength + line.length + 1 > MAX_OUTPUT_CHARACTERS) {
					lines.push("位置列表过长，剩余结果未展开；请缩小 path。");
					return { lines, outputTruncated: true };
				}
				lines.push(line);
				outputLength += line.length + 1;
				line = `${filePath}: ${position}`;
			} else {
				line += next;
			}
		}
		if (outputLength + line.length + 1 > MAX_OUTPUT_CHARACTERS) {
			lines.push("位置列表过长，剩余结果未展开；请缩小 path。");
			return { lines, outputTruncated: true };
		}
		lines.push(line);
		outputLength += line.length + 1;
	}
	return { lines, outputTruncated: false };
}

export interface AstGrepSearchService {
	search(
		request: AstGrepSearchRequest,
		cwd: string,
		signal?: AbortSignal,
		onStatus?: (message: string) => void,
	): Promise<AstGrepSearchResult>;
}

export class AstGrepService implements AstGrepSearchService {
	async search(
		request: AstGrepSearchRequest,
		cwd: string,
		signal?: AbortSignal,
		onStatus?: (message: string) => void,
	): Promise<AstGrepSearchResult> {
		const startedAt = Date.now();
		const requestedPath = request.path?.trim() || ".";
		const maxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;
		const timeoutController = new AbortController();
		const timeout = setTimeout(() => timeoutController.abort(new Error("timeout")), TIMEOUT_MS);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

		try {
			const { projectRoot, target } = await resolveSearchTarget(cwd, requestedPath);
			onStatus?.(`正在按代码结构搜索 ${requestedPath}…`);
			const { files, skippedFiles } = await collectFiles(target, request.language, combinedSignal);
			const matchers = new Map<AstGrepExplicitLanguage, NapiConfig | Error>();
			const matches: FileMatch[] = [];
			let scannedFiles = 0;
			let truncated = false;

			for (let index = 0; index < files.length; index += BATCH_SIZE) {
				if (combinedSignal.aborted) throw combinedSignal.reason;
				const batch = files.slice(index, index + BATCH_SIZE);
				const searchableBatch = batch.flatMap((filePath) => {
					const config = configForFile(filePath, request.language);
					if (!config) return [];
					let matcher = matchers.get(config.id);
					if (matcher === undefined) {
						try {
							matcher = compilePattern(config.lang, request.pattern);
						} catch (error) {
							matcher = error instanceof Error ? error : new Error(String(error));
						}
						matchers.set(config.id, matcher);
					}
					return matcher instanceof Error ? [] : [{ filePath, config, matcher }];
				});
				const batchMatches = await Promise.all(
					searchableBatch.map(({ filePath, config, matcher }) => searchFile(filePath, config.lang, matcher)),
				);
				scannedFiles += searchableBatch.length;
				for (const fileMatches of batchMatches) {
					for (const match of fileMatches) {
						if (matches.length >= maxResults) {
							truncated = true;
							break;
						}
						matches.push(match);
					}
					if (truncated) break;
				}
				if (truncated) break;
			}
			if (scannedFiles === 0 && files.length > 0) {
				const firstError = [...matchers.values()].find((matcher) => matcher instanceof Error);
				throw new Error(
					`ast_grep 结构模式无法用于所选文件：${firstError instanceof Error ? firstError.message : request.pattern}`,
				);
			}

			const formatted =
				matches.length <= SMALL_RESULT_LIMIT
					? {
							lines: matches.map(
								(match) =>
									`${formatPath(projectRoot, match.filePath)}:${match.line}:${match.column} ${match.text}`,
							),
							outputTruncated: false,
						}
					: formatGroupedMatches(matches, projectRoot);
			const lines = formatted.lines;
			if (truncated) lines.push(`结果已限制为 ${maxResults} 条；需要更多结果时请缩小 path 或提高 max_results。`);
			const details: AstGrepSearchDetails = {
				language: request.language,
				path: requestedPath,
				resultCount: matches.length,
				scannedFiles,
				skippedFiles,
				truncated,
				outputTruncated: formatted.outputTruncated,
				durationMs: Date.now() - startedAt,
			};
			return { text: lines.join("\n") || "没有找到符合该代码结构的结果。", details };
		} catch (error) {
			if (timeoutController.signal.aborted && !signal?.aborted) {
				throw new Error("ast_grep 搜索超过 15 秒，本次已停止；请缩小 path，或改用 grep。");
			}
			if (signal?.aborted) throw new Error("ast_grep 搜索已取消。");
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}
