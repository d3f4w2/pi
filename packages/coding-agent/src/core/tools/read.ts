import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	type CodeOutlineDetails,
	type CodeOutlineResult,
	type CodeOutlineService,
	defaultCodeOutlineService,
	SMART_READ_MAX_LINE_CHARACTERS,
	SMART_READ_MIN_LINES,
} from "./code-outline.ts";
import { createFileRevision, createLineAnchor, formatAnchoredText } from "./file-anchors.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";
import { materializeReadContent, type ReadSourceDetails, resolveUnifiedReadTarget } from "./unified-read.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	page: Type.Optional(
		Type.Integer({ minimum: 1, description: "PDF page to read (1-indexed); omit to read all pages" }),
	),
	entry: Type.Optional(
		Type.String({ description: "File inside a ZIP, TAR, or TAR.GZ archive; omit to list archive contents" }),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("full"), Type.Literal("outline")], {
			description:
				"auto outlines long code files; full returns verbatim content; outline forces a structural map when supported",
		}),
	),
});

export const readToolSystemPromptContribution = {
	snippet: "Read local files and resource content; local text includes stable edit anchors",
	guidelines: [
		"Use read for local files, webpages, PDFs, archives, and internal resource URIs instead of shell commands.",
		"When read returns line#hash anchors, use those anchors in edit instead of copying large oldText blocks.",
		"Long code reads may return a structural outline. Expand only the needed omitted range with offset/limit; use mode=full only when the entire implementation is necessary.",
		"For PDFs use page when one page is enough. For archives omit entry to list files, then read only the needed entry.",
	],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
	fileHash?: string;
	anchored?: boolean;
	outline?: CodeOutlineDetails;
	source?: ReadSourceDetails;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Custom structural outline service. Default: local AST/lexical summarizer */
	outlineService?: CodeOutlineService;
}

type ReadRenderArgs = {
	path?: string;
	file_path?: string;
	offset?: number;
	limit?: number;
	page?: number;
	entry?: string;
	mode?: "auto" | "full" | "outline";
};

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	const mode = args?.mode && args.mode !== "auto" ? theme.fg("muted", ` [${args.mode}]`) : "";
	const page = args?.page === undefined ? "" : theme.fg("muted", ` [page ${args.page}]`);
	const entry = args?.entry ? theme.fg("muted", ` [${args.entry}]`) : "";
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}${page}${entry}${mode}`;
}

function formatOutline(path: string, fileHash: string, outline: CodeOutlineResult): string {
	const lines = [
		`¶${path}#${fileHash}`,
		`[Outline: ${outline.details.totalLines} lines, ${outline.details.shownLines} source lines shown. Use mode="full" or offset/limit to expand.]`,
	];
	for (const item of outline.items) {
		if (item.type === "source") {
			const displayedContent =
				item.content.length <= SMART_READ_MAX_LINE_CHARACTERS
					? item.content
					: `${item.content.slice(0, SMART_READ_MAX_LINE_CHARACTERS)}… [truncated; use offset=${item.lineNumber} limit=1]`;
			lines.push(`${createLineAnchor(item.lineNumber, item.content)}|${displayedContent}`);
		} else {
			const limit = item.endLine - item.startLine + 1;
			lines.push(
				`[... lines ${item.startLine}-${item.endLine} omitted; use offset=${item.startLine} limit=${limit} ...]`,
			);
		}
	}
	return lines.join("\n");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

function utf8Prefix(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	const prefix = new TextDecoder().decode(bytes.subarray(0, maxBytes));
	return prefix.endsWith("\uFFFD") ? prefix.slice(0, -1) : prefix;
}

function formatExternalSourceMetadata(source: ReadSourceDetails): string {
	if (!source.untrusted || !source.sourceAddress || !source.readAt) return "";
	return `[source=${source.sourceAddress} read_at=${source.readAt} content_type=${source.contentType ?? source.mimeType ?? "unknown"} cache=${source.cached ? "hit" : "miss"} truncated=${source.truncated === true} untrusted=true sha256=${source.contentSha256 ?? "unknown"}]`;
}

async function formatTextRead(options: {
	path: string;
	textContent: string;
	offset?: number;
	limit?: number;
	mode: "auto" | "full" | "outline";
	anchored: boolean;
	outlineService: CodeOutlineService;
	source?: ReadSourceDetails;
	signal?: AbortSignal;
}): Promise<{ content: TextContent[]; details: ReadToolDetails | undefined }> {
	const fileHash = options.anchored ? createFileRevision(options.textContent) : undefined;
	const allLines = options.textContent.split("\n");
	const totalFileLines = allLines.length;
	const explicitRange = options.offset !== undefined || options.limit !== undefined;
	const shouldOutline =
		options.anchored &&
		!explicitRange &&
		options.mode !== "full" &&
		(options.mode === "outline" || totalFileLines >= SMART_READ_MIN_LINES);
	if (shouldOutline && fileHash) {
		let outline: CodeOutlineResult | undefined;
		try {
			outline = await options.outlineService.createOutline({
				path: options.path,
				content: options.textContent,
				force: options.mode === "outline",
			});
		} catch {}
		if (options.signal?.aborted) throw options.signal.reason;
		if (outline) {
			return {
				content: [{ type: "text", text: formatOutline(options.path, fileHash, outline) }],
				details: {
					fileHash,
					anchored: true,
					outline: outline.details,
					...(options.source ? { source: options.source } : {}),
				},
			};
		}
	}

	const startLine = options.offset ? Math.max(0, options.offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${options.offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (options.limit !== undefined) {
		const endLine = Math.min(startLine + options.limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else selectedContent = allLines.slice(startLine).join("\n");

	const truncation = truncateHead(selectedContent);
	const formatContent = (text: string): string =>
		options.anchored && fileHash ? formatAnchoredText(text, startLineDisplay, fileHash, options.path) : text;
	let outputText: string;
	let details: ReadToolDetails | undefined = options.source ? { source: { ...options.source } } : undefined;
	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[startLine] ?? "";
		const firstLineSize = formatSize(Buffer.byteLength(firstLine, "utf8"));
		outputText = `${formatContent(utf8Prefix(firstLine, DEFAULT_MAX_BYTES))}\n\n[Line ${startLineDisplay} is ${firstLineSize}; showing its first ${formatSize(DEFAULT_MAX_BYTES)}.]`;
		details = { ...details, truncation };
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = formatContent(truncation.content);
		if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		details = { ...details, truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${formatContent(truncation.content)}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else outputText = formatContent(truncation.content);
	const rangeTruncated =
		startLine > 0 || (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length);
	if (details?.source && (truncation.truncated || truncation.firstLineExceedsLimit || rangeTruncated)) {
		details.source.truncated = true;
	}
	if (details?.source) {
		const metadata = formatExternalSourceMetadata(details.source);
		if (metadata) outputText = `${metadata}\n${outputText}`;
	}
	if (options.anchored && fileHash) details = { ...details, fileHash, anchored: true };
	return { content: [{ type: "text", text: outputText }], details };
}

async function formatImageRead(options: {
	buffer: Uint8Array;
	mimeType: string;
	autoResizeImages: boolean;
	model: Model<Api> | undefined;
	source?: ReadSourceDetails;
}): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> {
	const processed = await processImage(Buffer.from(options.buffer), options.mimeType, {
		autoResizeImages: options.autoResizeImages,
	});
	const nonVisionImageNote = getNonVisionImageNote(options.model);
	if (!processed.ok) {
		let textNote = `Read image file [${options.mimeType}]\n${processed.message}`;
		if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
		return {
			content: [{ type: "text", text: textNote }],
			details: options.source ? { source: options.source } : undefined,
		};
	}
	let textNote = `Read image file [${processed.mimeType}]`;
	if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
	if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
	if (options.source) {
		const metadata = formatExternalSourceMetadata(options.source);
		if (metadata) textNote = `${metadata}\n${textNote}`;
	}
	return {
		content: [
			{ type: "text", text: textNote },
			{ type: "image", data: processed.data, mimeType: processed.mimeType },
		],
		details: options.source ? { source: options.source } : undefined,
	};
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	const outlineService = options?.outlineService ?? defaultCodeOutlineService;
	return {
		name: "read",
		label: "read",
		description: `Read local files, file/pi/internal resource URIs, webpages, PDFs, images, and ZIP/TAR/TAR.GZ archives through one interface. Local text uses stable edit anchors and long code can return a structural outline. Use page for one PDF page, or entry (also path.zip!/entry) for an archive member; omit entry to list it. Output is limited to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		async execute(
			_toolCallId,
			{ path, offset, limit, page, entry, mode = "auto" }: ReadToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const target = await resolveUnifiedReadTarget({ input: path, cwd, entry, signal });
							if (aborted) return;
							let result: { content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined };
							if (target.kind === "file") {
								const absolutePath = await resolveReadPathAsync(target.path, cwd);
								await ops.access(absolutePath);
								if (aborted) return;
								const detectedMimeType = ops.detectImageMimeType
									? await ops.detectImageMimeType(absolutePath)
									: undefined;
								const buffer = await ops.readFile(absolutePath);
								const imageMimeType = detectedMimeType ?? detectSupportedImageMimeType(buffer);
								if (imageMimeType) {
									result = await formatImageRead({
										buffer,
										mimeType: imageMimeType,
										autoResizeImages,
										model: ctx?.model,
									});
								} else {
									const materialized = await materializeReadContent({
										data: buffer,
										label: absolutePath,
										entry: target.entry,
										page,
									});
									if (materialized.kind === "binary") {
										throw new Error(`不支持直接读取二进制文件：${path}`);
									}
									const special =
										materialized.details.kind === "pdf" || materialized.details.kind === "archive";
									if (page !== undefined && page !== 1 && !special) throw new Error(`${path} 不是 PDF 文件。`);
									result = await formatTextRead({
										path,
										textContent: special ? (materialized.text ?? "") : buffer.toString("utf8"),
										offset,
										limit,
										mode,
										anchored:
											!special && getCompactReadClassification({ path: absolutePath }, cwd) === undefined,
										outlineService,
										...(special ? { source: materialized.details } : {}),
										signal,
									});
								}
							} else {
								const imageMimeType = detectSupportedImageMimeType(target.data);
								if (imageMimeType) {
									result = await formatImageRead({
										buffer: target.data,
										mimeType: imageMimeType,
										autoResizeImages,
										model: ctx?.model,
										source: {
											kind: target.external ? "web" : "resource",
											label: target.label,
											mimeType: target.mimeType,
											bytes: target.data.length,
											external: target.external,
											...target.metadata,
										},
									});
								} else {
									const materialized = await materializeReadContent({
										data: target.data,
										label: target.label,
										mimeType: target.mimeType,
										external: target.external,
										entry: target.entry,
										page,
									});
									if (target.metadata) materialized.details = { ...materialized.details, ...target.metadata };
									if (materialized.kind === "binary") {
										throw new Error(`不支持直接读取二进制资源：${target.label}`);
									}
									if (page !== undefined && page !== 1 && materialized.details.kind !== "pdf") {
										throw new Error(`${target.label} 不是 PDF 资源。`);
									}
									result = await formatTextRead({
										path: target.label,
										textContent: materialized.text ?? "",
										offset,
										limit,
										mode,
										anchored: false,
										outlineService,
										source: materialized.details,
										signal,
									});
								}
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve(result);
						} catch (error: unknown) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
