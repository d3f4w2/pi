import { createHash } from "node:crypto";

const LINE_HASH_LENGTH = 6;
const FILE_HASH_LENGTH = 10;
const ANCHOR_PATTERN = /^(\d+)#([A-Za-z0-9_-]{6})$/;

export interface AnchoredEdit {
	startAnchor: string;
	endAnchor?: string;
	newText: string;
}

export interface AppliedAnchoredEditsResult {
	baseContent: string;
	newContent: string;
}

interface ParsedAnchor {
	lineNumber: number;
	hash: string;
}

interface ResolvedAnchoredEdit {
	editIndex: number;
	startLine: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
	newText: string;
}

function normalizeAnchorText(text: string): string {
	const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
	return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function compactHash(text: string, length: number): string {
	return createHash("sha256").update(text, "utf8").digest("base64url").slice(0, length);
}

function createLineHash(content: string): string {
	return compactHash(content, LINE_HASH_LENGTH);
}

export function createFileRevision(content: string): string {
	return compactHash(normalizeAnchorText(content), FILE_HASH_LENGTH);
}

export function createLineAnchor(lineNumber: number, content: string): string {
	if (!Number.isInteger(lineNumber) || lineNumber < 1) {
		throw new Error(`Invalid line number for anchor: ${lineNumber}`);
	}
	return `${lineNumber}#${createLineHash(normalizeAnchorText(content))}`;
}

export function formatAnchoredText(content: string, startLine: number, fileHash: string, path?: string): string {
	const normalized = normalizeAnchorText(content);
	const lines = normalized.split("\n");
	const header = `¶${path ?? ""}#${fileHash}`;
	const anchoredLines = lines.map((line, index) => `${createLineAnchor(startLine + index, line)}|${line}`);
	return [header, ...anchoredLines].join("\n");
}

function parseAnchor(
	anchor: string,
	path: string,
	editIndex: number,
	field: "startAnchor" | "endAnchor",
): ParsedAnchor {
	const match = ANCHOR_PATTERN.exec(anchor);
	if (!match) {
		throw new Error(
			`edits[${editIndex}].${field} is invalid in ${path}. Reread the file and copy the complete line#hash anchor.`,
		);
	}
	const lineNumber = Number(match[1]);
	if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
		throw new Error(`edits[${editIndex}].${field} has an invalid line number in ${path}.`);
	}
	return { lineNumber, hash: match[2] };
}

function resolveAnchor(
	lines: string[],
	anchor: ParsedAnchor,
	path: string,
	editIndex: number,
	field: "startAnchor" | "endAnchor",
): number {
	const hintedIndex = anchor.lineNumber - 1;
	if (hintedIndex < lines.length && createLineHash(lines[hintedIndex]) === anchor.hash) {
		return hintedIndex;
	}

	const candidates: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (createLineHash(lines[index]) === anchor.hash) candidates.push(index);
	}
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0) {
		throw new Error(`edits[${editIndex}].${field} no longer exists in ${path}. Reread the affected lines and retry.`);
	}
	throw new Error(
		`edits[${editIndex}].${field} is ambiguous in ${path} (${candidates.length} matching lines). Reread a focused range and use its current anchor.`,
	);
}

function getLineOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}
	return offsets;
}

export function applyAnchoredEdits(
	normalizedContent: string,
	edits: AnchoredEdit[],
	path: string,
): AppliedAnchoredEditsResult {
	const baseContent = normalizeAnchorText(normalizedContent);
	const lines = baseContent.split("\n");
	const lineOffsets = getLineOffsets(lines);
	const resolved: ResolvedAnchoredEdit[] = edits.map((edit, editIndex) => {
		const start = parseAnchor(edit.startAnchor, path, editIndex, "startAnchor");
		const end = edit.endAnchor ? parseAnchor(edit.endAnchor, path, editIndex, "endAnchor") : start;
		const startLine = resolveAnchor(lines, start, path, editIndex, "startAnchor");
		const endLine = edit.endAnchor ? resolveAnchor(lines, end, path, editIndex, "endAnchor") : startLine;
		if (startLine > endLine) {
			throw new Error(`edits[${editIndex}] has a reversed anchor range in ${path}.`);
		}

		const startOffset = lineOffsets[startLine];
		let endOffset = lineOffsets[endLine] + lines[endLine].length;
		const newText = normalizeAnchorText(edit.newText);
		if (newText.length === 0 && endLine < lines.length - 1) endOffset++;
		return { editIndex, startLine, endLine, startOffset, endOffset, newText };
	});

	resolved.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
	for (let index = 1; index < resolved.length; index++) {
		const previous = resolved[index - 1];
		const current = resolved[index];
		if (previous.endLine >= current.startLine) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one anchored edit.`,
			);
		}
	}

	let newContent = baseContent;
	for (let index = resolved.length - 1; index >= 0; index--) {
		const edit = resolved[index];
		newContent = newContent.slice(0, edit.startOffset) + edit.newText + newContent.slice(edit.endOffset);
	}
	if (newContent === baseContent) {
		throw new Error(`No changes made to ${path}. The anchored replacements produced identical content.`);
	}
	return { baseContent, newContent };
}
