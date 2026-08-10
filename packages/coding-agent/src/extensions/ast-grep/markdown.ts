import type { AstGrepCapture, AstGrepRange } from "./types.ts";

export interface MarkdownMatch {
	startOffset: number;
	endOffset: number;
	text: string;
	range: AstGrepRange;
	captures: Record<string, AstGrepCapture[]>;
}

interface OffsetTable {
	lineStarts: number[];
	source: string;
}

function byteIndex(source: string, offset: number): number {
	return Buffer.byteLength(source.slice(0, offset), "utf8");
}

function offsetTable(source: string): OffsetTable {
	const lineStarts = [0];
	for (let index = 0; index < source.length; index++) {
		if (source.charCodeAt(index) === 10) lineStarts.push(index + 1);
	}
	return { lineStarts, source };
}

function positionAt(table: OffsetTable, offset: number): AstGrepRange["start"] {
	let low = 0;
	let high = table.lineStarts.length;
	while (low + 1 < high) {
		const middle = Math.floor((low + high) / 2);
		if ((table.lineStarts[middle] ?? 0) <= offset) low = middle;
		else high = middle;
	}
	const lineStart = table.lineStarts[low] ?? 0;
	return { line: low + 1, column: offset - lineStart + 1, index: byteIndex(table.source, offset) };
}

function rangeAt(table: OffsetTable, start: number, end: number): AstGrepRange {
	return { start: positionAt(table, start), end: positionAt(table, end) };
}

function capture(table: OffsetTable, source: string, start: number, end: number): AstGrepCapture {
	return { text: source.slice(start, end), range: rangeAt(table, start, end) };
}

function addMatch(
	matches: MarkdownMatch[],
	table: OffsetTable,
	start: number,
	end: number,
	captures: Record<string, AstGrepCapture[]>,
): void {
	matches.push({
		startOffset: start,
		endOffset: end,
		text: table.source.slice(start, end),
		range: rangeAt(table, start, end),
		captures,
	});
}

function headingMatches(source: string, pattern: string, table: OffsetTable): MarkdownMatch[] | undefined {
	const parsed = /^(#{1,6})[ \t]+\$([A-Z_][A-Z0-9_]*)$/.exec(pattern);
	if (!parsed) return undefined;
	const marker = parsed[1];
	const name = parsed[2];
	if (!marker || !name) return [];
	const matches: MarkdownMatch[] = [];
	const linePattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
	for (const candidate of source.matchAll(linePattern)) {
		if (candidate[1] !== marker || candidate.index === undefined || candidate[2] === undefined) continue;
		const full = candidate[0];
		const titleOffset = full.indexOf(candidate[2]);
		const start = candidate.index;
		addMatch(matches, table, start, start + full.length, {
			[name]: [capture(table, source, start + titleOffset, start + titleOffset + candidate[2].length)],
		});
	}
	return matches;
}

function linkMatches(source: string, pattern: string, table: OffsetTable): MarkdownMatch[] | undefined {
	const parsed = /^\[\$([A-Z_][A-Z0-9_]*)\]\(\$([A-Z_][A-Z0-9_]*)\)$/.exec(pattern);
	if (!parsed) return undefined;
	const textName = parsed[1];
	const urlName = parsed[2];
	if (!textName || !urlName) return [];
	const matches: MarkdownMatch[] = [];
	const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	for (const candidate of source.matchAll(linkPattern)) {
		if (candidate.index === undefined || candidate[1] === undefined || candidate[2] === undefined) continue;
		const start = candidate.index;
		const textStart = start + 1;
		const urlStart = start + candidate[0].indexOf(candidate[2]);
		addMatch(matches, table, start, start + candidate[0].length, {
			[textName]: [capture(table, source, textStart, textStart + candidate[1].length)],
			[urlName]: [capture(table, source, urlStart, urlStart + candidate[2].length)],
		});
	}
	return matches;
}

function fenceMatches(source: string, pattern: string, table: OffsetTable): MarkdownMatch[] | undefined {
	const parsed = /^```\$([A-Z_][A-Z0-9_]*)\n\$\$\$([A-Z_][A-Z0-9_]*)\n```$/.exec(pattern);
	if (!parsed) return undefined;
	const languageName = parsed[1];
	const bodyName = parsed[2];
	if (!languageName || !bodyName) return [];
	const matches: MarkdownMatch[] = [];
	const fencePattern = /^```([^\s`]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
	for (const candidate of source.matchAll(fencePattern)) {
		if (candidate.index === undefined || candidate[1] === undefined || candidate[2] === undefined) continue;
		const start = candidate.index;
		const languageStart = start + 3;
		const bodyStart = start + candidate[0].indexOf(candidate[2], 3 + candidate[1].length);
		addMatch(matches, table, start, start + candidate[0].length, {
			[languageName]: [capture(table, source, languageStart, languageStart + candidate[1].length)],
			[bodyName]: [capture(table, source, bodyStart, bodyStart + candidate[2].length)],
		});
	}
	return matches;
}

export function findMarkdownMatches(source: string, pattern: string): MarkdownMatch[] {
	const table = offsetTable(source);
	const matches =
		headingMatches(source, pattern, table) ??
		linkMatches(source, pattern, table) ??
		fenceMatches(source, pattern, table);
	if (!matches) {
		throw new Error(
			"Markdown 结构模式仅支持标题（# $TITLE）、链接（[$TEXT]($URL)）和围栏代码块（```$LANG\\n$$$BODY\\n```）。",
		);
	}
	return matches;
}

export function expandMarkdownReplacement(match: MarkdownMatch, replacement: string): string {
	return replacement.replace(/\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g, (placeholder, multi, single) => {
		const name = String(multi ?? single);
		const captures = match.captures[name] ?? [];
		if (captures.length === 0) throw new Error(`替换模板中的 ${placeholder} 没有对应的捕获内容。`);
		return captures.map((item) => item.text).join("");
	});
}
