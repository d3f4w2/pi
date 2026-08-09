import { createHash } from "node:crypto";
import path from "node:path";
import { Lang, parseAsync, type SgNode } from "@ast-grep/napi";

export const SMART_READ_MIN_LINES = 160;
export const SMART_READ_MAX_LINE_CHARACTERS = 500;
const MAX_PARSE_BYTES = 1_000_000;
const MAX_VISIBLE_LINES = 120;
const MAX_SIGNATURE_LINES = 3;
const MAX_CACHE_ENTRIES = 64;
const MIN_OMISSION_MARKER_LINES = 8;

export type CodeOutlineStrategy = "ast" | "lexical";

export type CodeOutlineItem =
	| { type: "source"; lineNumber: number; content: string }
	| { type: "omitted"; startLine: number; endLine: number };

export interface CodeOutlineDetails {
	strategy: CodeOutlineStrategy;
	totalLines: number;
	shownLines: number;
	omittedLines: number;
	cacheHit: boolean;
}

export interface CodeOutlineResult {
	items: CodeOutlineItem[];
	details: CodeOutlineDetails;
}

export interface CodeOutlineRequest {
	path: string;
	content: string;
	force: boolean;
}

export interface CodeOutlineService {
	createOutline(request: CodeOutlineRequest): Promise<CodeOutlineResult | undefined>;
}

interface OutlineLanguage {
	id: string;
	strategy: CodeOutlineStrategy;
	lang?: Lang;
}

interface CachedOutline {
	items: CodeOutlineItem[];
	details: Omit<CodeOutlineDetails, "cacheHit">;
}

const AST_LANGUAGES: Readonly<Record<string, OutlineLanguage>> = {
	".js": { id: "javascript", strategy: "ast", lang: Lang.JavaScript },
	".jsx": { id: "javascript", strategy: "ast", lang: Lang.JavaScript },
	".mjs": { id: "javascript", strategy: "ast", lang: Lang.JavaScript },
	".cjs": { id: "javascript", strategy: "ast", lang: Lang.JavaScript },
	".ts": { id: "typescript", strategy: "ast", lang: Lang.TypeScript },
	".mts": { id: "typescript", strategy: "ast", lang: Lang.TypeScript },
	".cts": { id: "typescript", strategy: "ast", lang: Lang.TypeScript },
	".tsx": { id: "tsx", strategy: "ast", lang: Lang.Tsx },
	".html": { id: "html", strategy: "ast", lang: Lang.Html },
	".htm": { id: "html", strategy: "ast", lang: Lang.Html },
	".css": { id: "css", strategy: "ast", lang: Lang.Css },
};

const LEXICAL_LANGUAGES: Readonly<Record<string, OutlineLanguage>> = {
	".py": { id: "python", strategy: "lexical" },
	".pyi": { id: "python", strategy: "lexical" },
	".go": { id: "go", strategy: "lexical" },
};

const DECLARATION_KIND =
	/(?:declaration|definition|method|constructor|signature|field|property|function|class|interface|enum|type_alias)/;
const CONTAINER_KIND =
	/(?:export_statement|class_body|interface_body|object_type|enum_body|namespace_body|module_body|declaration_list)/;
const COMMENT_KIND = /comment/;
const IMPORT_KIND = /(?:import|export)_statement/;

function normalizeContent(content: string): string {
	const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
	return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLanguage(filePath: string): OutlineLanguage | undefined {
	const extension = path.extname(filePath).toLowerCase();
	return AST_LANGUAGES[extension] ?? LEXICAL_LANGUAGES[extension];
}

function setPriority(priorities: Map<number, number>, line: number, priority: number, totalLines: number): void {
	if (line < 0 || line >= totalLines) return;
	priorities.set(line, Math.max(priority, priorities.get(line) ?? 0));
}

function addSignatureLines(
	node: SgNode,
	lines: readonly string[],
	priorities: Map<number, number>,
	priority: number,
	includeEnd: boolean,
): void {
	const range = node.range();
	const startLine = range.start.line;
	const endLine = range.end.line;
	setPriority(priorities, startLine, priority, lines.length);
	if (!lines[startLine]?.includes("{")) {
		for (let line = startLine + 1; line <= Math.min(endLine, startLine + MAX_SIGNATURE_LINES - 1); line++) {
			setPriority(priorities, line, priority - 10, lines.length);
			if (lines[line]?.includes("{")) break;
		}
	}
	if (includeEnd && endLine > startLine) setPriority(priorities, endLine, priority - 40, lines.length);
}

function collectNestedDeclarations(
	node: SgNode,
	lines: readonly string[],
	priorities: Map<number, number>,
	depth: number,
): void {
	if (depth > 6) return;
	for (const child of node.children()) {
		if (!child.isNamed()) continue;
		const kind = String(child.kind());
		const isDeclaration = DECLARATION_KIND.test(kind);
		if (isDeclaration) {
			const isMember = /(?:method|constructor|field|property|signature)/.test(kind);
			addSignatureLines(child, lines, priorities, 90 - depth, !isMember && depth <= 1);
		}
		if (CONTAINER_KIND.test(kind) || (isDeclaration && /(?:class|interface|enum|type_alias)/.test(kind))) {
			collectNestedDeclarations(child, lines, priorities, depth + 1);
		}
	}
}

async function collectAstPriorities(
	content: string,
	lines: readonly string[],
	language: OutlineLanguage,
): Promise<Map<number, number>> {
	if (!language.lang) return new Map();
	const root = (await parseAsync(language.lang, content)).root();
	const priorities = new Map<number, number>();
	for (const child of root.children()) {
		if (!child.isNamed()) continue;
		const kind = String(child.kind());
		if (COMMENT_KIND.test(kind)) {
			addSignatureLines(child, lines, priorities, 60, false);
			continue;
		}
		const priority = IMPORT_KIND.test(kind) ? 100 : 95;
		const includeEnd = !/(?:function|method)/.test(kind);
		addSignatureLines(child, lines, priorities, priority, includeEnd);
		collectNestedDeclarations(child, lines, priorities, 1);
	}
	return priorities;
}

function collectPythonPriorities(lines: readonly string[]): Map<number, number> {
	const priorities = new Map<number, number>();
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (/^(?:from\s+\S+\s+import|import\s+)/.test(line)) {
			setPriority(priorities, index, 100, lines.length);
			continue;
		}
		if (/^\s*(?:async\s+def|def|class)\s+[A-Za-z_]/.test(line)) {
			setPriority(priorities, index, 90, lines.length);
			let decorator = index - 1;
			while (decorator >= 0 && /^\s*@/.test(lines[decorator])) {
				setPriority(priorities, decorator, 91, lines.length);
				decorator--;
			}
			continue;
		}
		if (/^[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=/.test(line)) setPriority(priorities, index, 70, lines.length);
	}
	return priorities;
}

function collectGoPriorities(lines: readonly string[]): Map<number, number> {
	const priorities = new Map<number, number>();
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (/^(?:package|import)\b/.test(line)) {
			setPriority(priorities, index, 100, lines.length);
			continue;
		}
		if (/^(?:func|type|const|var)\b/.test(line)) setPriority(priorities, index, 90, lines.length);
	}
	return priorities;
}

function collectLexicalPriorities(lines: readonly string[], language: OutlineLanguage): Map<number, number> {
	return language.id === "python" ? collectPythonPriorities(lines) : collectGoPriorities(lines);
}

function sampleEvenly(entries: Array<[number, number]>, count: number): Array<[number, number]> {
	if (count >= entries.length) return entries;
	if (count <= 1) return entries.length > 0 ? [entries[0]] : [];
	const sampled: Array<[number, number]> = [];
	for (let index = 0; index < count; index++) {
		const sourceIndex = Math.round((index * (entries.length - 1)) / (count - 1));
		sampled.push(entries[sourceIndex]);
	}
	return sampled;
}

function applyLineBudget(priorities: Map<number, number>): number[] {
	const groups = new Map<number, Array<[number, number]>>();
	for (const entry of priorities) {
		const group = groups.get(entry[1]) ?? [];
		group.push(entry);
		groups.set(entry[1], group);
	}

	const selected: Array<[number, number]> = [];
	for (const priority of [...groups.keys()].sort((a, b) => b - a)) {
		const group = groups.get(priority)?.sort((a, b) => a[0] - b[0]) ?? [];
		const remaining = MAX_VISIBLE_LINES - selected.length;
		if (remaining <= 0) break;
		selected.push(...sampleEvenly(group, remaining));
	}
	return [...new Set(selected.map(([line]) => line))].sort((a, b) => a - b);
}

function buildItems(lines: readonly string[], visibleLines: readonly number[]): CodeOutlineItem[] {
	const items: CodeOutlineItem[] = [];
	let previousLine = -1;
	for (const lineIndex of visibleLines) {
		if (lineIndex - previousLine - 1 >= MIN_OMISSION_MARKER_LINES) {
			items.push({ type: "omitted", startLine: previousLine + 2, endLine: lineIndex });
		}
		items.push({ type: "source", lineNumber: lineIndex + 1, content: lines[lineIndex] ?? "" });
		previousLine = lineIndex;
	}
	if (lines.length - previousLine - 1 >= MIN_OMISSION_MARKER_LINES) {
		items.push({ type: "omitted", startLine: previousLine + 2, endLine: lines.length });
	}
	return items;
}

function estimateFormattedCharacters(items: readonly CodeOutlineItem[]): number {
	let characters = 160;
	for (const item of items) {
		characters += item.type === "source" ? Math.min(item.content.length, SMART_READ_MAX_LINE_CHARACTERS) + 18 : 64;
	}
	return characters;
}

function cloneOutline(cached: CachedOutline, cacheHit: boolean): CodeOutlineResult {
	return {
		items: cached.items.map((item) => ({ ...item })),
		details: { ...cached.details, cacheHit },
	};
}

export class LocalCodeOutlineService implements CodeOutlineService {
	readonly #cache = new Map<string, CachedOutline>();

	async createOutline(request: CodeOutlineRequest): Promise<CodeOutlineResult | undefined> {
		const language = detectLanguage(request.path);
		if (!language || Buffer.byteLength(request.content, "utf8") > MAX_PARSE_BYTES) return undefined;

		const content = normalizeContent(request.content);
		const lines = content.split("\n");
		const cacheKey = `${language.id}:${createHash("sha256").update(content).digest("base64url")}`;
		const cached = this.#cache.get(cacheKey);
		if (cached) {
			this.#cache.delete(cacheKey);
			this.#cache.set(cacheKey, cached);
			return cloneOutline(cached, true);
		}

		const priorities =
			language.strategy === "ast"
				? await collectAstPriorities(content, lines, language)
				: collectLexicalPriorities(lines, language);
		if (priorities.size === 0) return undefined;

		const visibleLines = applyLineBudget(priorities);
		const omittedLines = lines.length - visibleLines.length;
		if (!request.force && (omittedLines < 20 || visibleLines.length >= lines.length * 0.8)) return undefined;

		const items = buildItems(lines, visibleLines);
		if (!request.force && estimateFormattedCharacters(items) >= content.length * 0.75) return undefined;

		const cachedOutline: CachedOutline = {
			items,
			details: {
				strategy: language.strategy,
				totalLines: lines.length,
				shownLines: visibleLines.length,
				omittedLines,
			},
		};
		this.#cache.set(cacheKey, cachedOutline);
		if (this.#cache.size > MAX_CACHE_ENTRIES) {
			const oldestKey = this.#cache.keys().next().value;
			if (oldestKey !== undefined) this.#cache.delete(oldestKey);
		}
		return cloneOutline(cachedOutline, false);
	}
}

export const defaultCodeOutlineService = new LocalCodeOutlineService();
