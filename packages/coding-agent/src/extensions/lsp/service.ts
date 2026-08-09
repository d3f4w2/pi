import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	Position,
	Range,
	SymbolInformation,
	SymbolKind,
	TextEdit,
	WorkspaceEdit,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { startLanguageClient } from "./client.ts";
import {
	detectLanguageAdapter,
	findLanguageWorkspaceRoot,
	formatLanguageServerSetup,
	formatLanguageServerStartup,
} from "./languages.ts";
import type {
	LanguageAdapter,
	LspClient,
	LspClientFactory,
	LspDocument,
	LspToolRequest,
	LspToolResult,
} from "./types.ts";
import { runWorkspaceDiagnostics, type WorkspaceDiagnosticsOptions } from "./workspace-diagnostics.ts";

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 100;

interface LspServiceOptions {
	clientFactory?: LspClientFactory;
	workspaceDiagnostics?: WorkspaceDiagnosticsOptions;
}

interface PositionInput {
	line?: number;
	column?: number;
	symbol?: string;
}

interface FormattedResult {
	text: string;
	count: number;
	truncated: boolean;
}

interface LspTargetRequest {
	path: string;
	symbol?: string;
}

interface ResolvedLspTarget {
	projectRoot: string;
	filePath: string;
	adapter: LanguageAdapter;
	workspaceRoot: string;
}

export interface WorkspaceEditFileSystem {
	readFile(filePath: string, encoding: "utf8"): Promise<string>;
	realpath(filePath: string): Promise<string>;
	writeFile(filePath: string, content: string, encoding: "utf8"): Promise<void>;
}

export interface SafeWorkspaceEditOptions {
	fileSystem?: WorkspaceEditFileSystem;
	expectedContents?: ReadonlyMap<string, string>;
}

export interface AppliedWorkspaceEdit {
	changedFiles: string[];
	editCount: number;
}

function isPathInside(root: string, candidate: string): boolean {
	const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
	const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function lineText(document: LspDocument, line: number): string {
	const lines = document.text.split(/\r?\n/);
	if (line < 1 || line > lines.length) throw new Error(`行号 ${line} 超出文件范围（共 ${lines.length} 行）。`);
	return lines[line - 1] ?? "";
}

function findSymbolOffsets(text: string, symbol: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	while (offset <= text.length - symbol.length) {
		const found = text.indexOf(symbol, offset);
		if (found < 0) break;
		const identifier = /^[\p{L}\p{N}_$]+$/u.test(symbol);
		const before = found > 0 ? text[found - 1] : undefined;
		const after = text[found + symbol.length];
		const boundaryBefore = !identifier || before === undefined || !/[\p{L}\p{N}_$]/u.test(before);
		const boundaryAfter = !identifier || after === undefined || !/[\p{L}\p{N}_$]/u.test(after);
		if (boundaryBefore && boundaryAfter) offsets.push(found);
		offset = found + Math.max(symbol.length, 1);
	}
	return offsets;
}

export function resolveLspPosition(document: LspDocument, input: PositionInput): Position {
	if (input.line !== undefined && input.column !== undefined) {
		const text = lineText(document, input.line);
		if (input.column < 1 || input.column > text.length + 1) {
			throw new Error(`列号 ${input.column} 超出第 ${input.line} 行范围。`);
		}
		return { line: input.line - 1, character: input.column - 1 };
	}
	if (!input.symbol?.trim()) throw new Error("该 LSP 操作需要 line + column，或者一个准确的 symbol。");
	const symbol = input.symbol.trim();
	if (input.line !== undefined) {
		const offsets = findSymbolOffsets(lineText(document, input.line), symbol);
		if (offsets.length === 0) throw new Error(`第 ${input.line} 行没有找到符号 ${symbol}。`);
		if (offsets.length > 1) {
			throw new Error(
				`第 ${input.line} 行有多个 ${symbol}，请提供 column：${offsets.map((value) => value + 1).join("、")}。`,
			);
		}
		return { line: input.line - 1, character: offsets[0] ?? 0 };
	}

	const candidates: Position[] = [];
	for (const [lineIndex, text] of document.text.split(/\r?\n/).entries()) {
		for (const character of findSymbolOffsets(text, symbol)) candidates.push({ line: lineIndex, character });
	}
	if (candidates.length === 0) throw new Error(`文件中没有找到符号 ${symbol}。`);
	if (candidates.length > 1) {
		const lines = [...new Set(candidates.map((position) => position.line + 1))];
		throw new Error(`符号 ${symbol} 出现多次，位于第 ${lines.join("、")} 行；请提供 line 和必要的 column。`);
	}
	return candidates[0] ?? { line: 0, character: 0 };
}

function locationParts(location: Location | LocationLink): { uri: string; range: Range } {
	return "uri" in location
		? { uri: location.uri, range: location.range }
		: { uri: location.targetUri, range: location.targetSelectionRange };
}

function displayPathFromUri(uri: string, projectRoot: string): string {
	try {
		const filePath = fileURLToPath(uri);
		if (!isPathInside(projectRoot, filePath)) return filePath.replaceAll("\\", "/");
		const relative = path.relative(projectRoot, filePath).replaceAll("\\", "/");
		return relative || path.basename(filePath);
	} catch {
		return uri;
	}
}

function formatLocations(
	locations: Array<Location | LocationLink>,
	projectRoot: string,
	maxResults: number,
): FormattedResult {
	const lines = [
		...new Set(
			locations.map((location) => {
				const { uri, range } = locationParts(location);
				return `${displayPathFromUri(uri, projectRoot)}:${range.start.line + 1}:${range.start.character + 1}`;
			}),
		),
	].sort();
	const shown = lines.slice(0, maxResults);
	return {
		text: shown.length > 0 ? shown.join("\n") : "没有找到结果。",
		count: lines.length,
		truncated: lines.length > shown.length,
	};
}

function hoverText(hover: Hover | null): string {
	if (!hover) return "没有类型或说明信息。";
	const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
	const text = contents
		.map((content) => {
			if (typeof content === "string") return content;
			if ("kind" in content) return content.value;
			return `\`\`\`${content.language}\n${content.value}\n\`\`\``;
		})
		.filter((content) => content.trim().length > 0)
		.join("\n\n");
	return text.length > 6_000 ? `${text.slice(0, 6_000)}\n\n[内容已截断]` : text || "没有类型或说明信息。";
}

function symbolKindName(kind: SymbolKind): string {
	const names: readonly string[] = [
		"Unknown",
		"File",
		"Module",
		"Namespace",
		"Package",
		"Class",
		"Method",
		"Property",
		"Field",
		"Constructor",
		"Enum",
		"Interface",
		"Function",
		"Variable",
		"Constant",
		"String",
		"Number",
		"Boolean",
		"Array",
		"Object",
		"Key",
		"Null",
		"EnumMember",
		"Struct",
		"Event",
		"Operator",
		"TypeParameter",
	];
	return names[kind] ?? `Kind${kind}`;
}

function formatDocumentSymbols(
	symbols: Array<DocumentSymbol | SymbolInformation>,
	filePath: string,
	projectRoot: string,
	maxResults: number,
): FormattedResult {
	const output: string[] = [];
	const visit = (symbol: DocumentSymbol, depth: number) => {
		if (output.length >= maxResults) return;
		output.push(
			`${"  ".repeat(depth)}${symbol.name} [${symbolKindName(symbol.kind)}] ${path.relative(projectRoot, filePath).replaceAll("\\", "/")}:${symbol.selectionRange.start.line + 1}:${symbol.selectionRange.start.character + 1}`,
		);
		for (const child of symbol.children ?? []) visit(child, depth + 1);
	};
	for (const symbol of symbols) {
		if (output.length >= maxResults) break;
		if ("range" in symbol) visit(symbol, 0);
		else {
			output.push(
				`${symbol.name} [${symbolKindName(symbol.kind)}] ${displayPathFromUri(symbol.location.uri, projectRoot)}:${symbol.location.range.start.line + 1}:${symbol.location.range.start.character + 1}`,
			);
		}
	}
	return {
		text: output.length > 0 ? output.join("\n") : "文件中没有可用符号。",
		count: output.length,
		truncated: symbols.length > output.length,
	};
}

function formatWorkspaceSymbols(
	symbols: Array<SymbolInformation | WorkspaceSymbol>,
	projectRoot: string,
	maxResults: number,
): FormattedResult {
	const lines = symbols.slice(0, maxResults).map((symbol) => {
		const range = "range" in symbol.location ? symbol.location.range : undefined;
		return `${symbol.name} [${symbolKindName(symbol.kind)}] ${displayPathFromUri(symbol.location.uri, projectRoot)}:${(range?.start.line ?? 0) + 1}:${(range?.start.character ?? 0) + 1}`;
	});
	return {
		text: lines.length > 0 ? lines.join("\n") : "工作区中没有找到符号。",
		count: symbols.length,
		truncated: symbols.length > lines.length,
	};
}

function formatDiagnostics(
	diagnostics: Diagnostic[],
	filePath: string,
	projectRoot: string,
	maxResults: number,
): FormattedResult {
	const severity = ["未知", "错误", "警告", "信息", "提示"];
	const relative = path.relative(projectRoot, filePath).replaceAll("\\", "/");
	const lines = diagnostics.slice(0, maxResults).map((diagnostic) => {
		const source = [diagnostic.source, diagnostic.code].filter((value) => value !== undefined).join("/");
		const message = typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
		return `${relative}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} [${severity[diagnostic.severity ?? 0] ?? "未知"}] ${message.replaceAll("\n", " ")}${source ? ` (${source})` : ""}`;
	});
	return {
		text: lines.length > 0 ? lines.join("\n") : "没有发现错误或警告。",
		count: diagnostics.length,
		truncated: diagnostics.length > lines.length,
	};
}

function positionOffset(text: string, position: Position): number {
	const starts = [0];
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) starts.push(index + 1);
	}
	const start = starts[position.line];
	if (start === undefined) throw new Error(`LSP 编辑行号 ${position.line + 1} 超出文件范围。`);
	const nextStart = starts[position.line + 1] ?? text.length + 1;
	let contentEnd = Math.min(nextStart - 1, text.length);
	if (contentEnd > start && text.charCodeAt(contentEnd - 1) === 13) contentEnd--;
	if (position.character < 0 || start + position.character > contentEnd) {
		throw new Error(`LSP 编辑列号 ${position.character + 1} 超出第 ${position.line + 1} 行范围。`);
	}
	return start + position.character;
}

export async function applyWorkspaceEditSafely(
	workspaceEdit: WorkspaceEdit,
	projectRoot: string,
	options: SafeWorkspaceEditOptions = {},
): Promise<AppliedWorkspaceEdit> {
	const fileSystem: WorkspaceEditFileSystem = options.fileSystem ?? { readFile, realpath, writeFile };
	const resolvedProject = await fileSystem.realpath(projectRoot);
	const editsByUri = new Map<string, TextEdit[]>();
	for (const [uri, edits] of Object.entries(workspaceEdit.changes ?? {})) {
		editsByUri.set(uri, [...(editsByUri.get(uri) ?? []), ...edits]);
	}
	for (const change of workspaceEdit.documentChanges ?? []) {
		if (!("textDocument" in change)) {
			throw new Error("LSP rename 返回了创建、删除或移动文件操作；Pi 为安全起见没有执行。");
		}
		const uri = change.textDocument.uri;
		const edits = editsByUri.get(uri) ?? [];
		for (const edit of change.edits) {
			if (!("newText" in edit)) throw new Error("LSP rename 返回了 snippet 编辑；Pi 为安全起见没有执行。");
			edits.push(edit);
		}
		editsByUri.set(uri, edits);
	}
	if (editsByUri.size === 0) return { changedFiles: [], editCount: 0 };

	const prepared: Array<{ filePath: string; original: string; content: string; editCount: number }> = [];
	for (const [uri, edits] of editsByUri) {
		let filePath: string;
		try {
			filePath = await fileSystem.realpath(fileURLToPath(uri));
		} catch {
			throw new Error(`LSP rename 返回了无法读取的文件地址：${uri}`);
		}
		if (!isPathInside(resolvedProject, filePath))
			throw new Error(`LSP rename 试图修改当前项目之外的文件：${filePath}`);
		const original = await fileSystem.readFile(filePath, "utf8");
		const expected = options.expectedContents?.get(filePath);
		if (expected !== undefined && expected !== original)
			throw new Error(`文件在 LSP 分析后发生变化，已拒绝重命名：${filePath}`);
		const ranges = edits.map((edit) => ({
			start: positionOffset(original, edit.range.start),
			end: positionOffset(original, edit.range.end),
			newText: edit.newText,
		}));
		ranges.sort((left, right) => left.start - right.start || left.end - right.end);
		for (let index = 1; index < ranges.length; index++) {
			const previous = ranges[index - 1];
			const current = ranges[index];
			if (previous && current && current.start < previous.end)
				throw new Error(`LSP rename 返回了重叠编辑：${filePath}`);
		}
		let content = original;
		for (const edit of [...ranges].reverse())
			content = `${content.slice(0, edit.start)}${edit.newText}${content.slice(edit.end)}`;
		prepared.push({ filePath, original, content, editCount: edits.length });
	}

	const written: typeof prepared = [];
	try {
		for (const file of prepared) {
			await fileSystem.writeFile(file.filePath, file.content, "utf8");
			written.push(file);
		}
	} catch (error) {
		const rollbackFailures: string[] = [];
		for (const file of [...written].reverse()) {
			try {
				await fileSystem.writeFile(file.filePath, file.original, "utf8");
			} catch {
				rollbackFailures.push(file.filePath);
			}
		}
		const detail = error instanceof Error ? error.message : String(error);
		if (rollbackFailures.length > 0) {
			throw new Error(`LSP rename 写入失败且以下文件回滚失败：${rollbackFailures.join("、")}。原错误：${detail}`);
		}
		throw new Error(`LSP rename 写入失败，已恢复原文件：${detail}`);
	}
	return {
		changedFiles: prepared.map((file) => file.filePath),
		editCount: prepared.reduce((total, file) => total + file.editCount, 0),
	};
}

export class LspService {
	private readonly clientFactory: LspClientFactory;
	private readonly workspaceDiagnosticsOptions: WorkspaceDiagnosticsOptions;
	private readonly clients = new Map<string, Promise<LspClient>>();
	private readonly startupFailures = new Map<string, string>();

	constructor(options: LspServiceOptions = {}) {
		this.clientFactory = options.clientFactory ?? startLanguageClient;
		this.workspaceDiagnosticsOptions = options.workspaceDiagnostics ?? {};
	}

	async warmup(requestPath: string, cwd: string, onStatus?: (message: string) => void): Promise<void> {
		const target = await this.resolveTarget({ path: requestPath }, cwd);
		const client = await this.getClient(target.adapter, target.workspaceRoot, onStatus);
		await client.openDocument(target.filePath);
	}

	async execute(
		request: LspToolRequest,
		cwd: string,
		signal?: AbortSignal,
		onStatus?: (message: string) => void,
	): Promise<LspToolResult> {
		if (request.path === "*") {
			if (request.operation !== "diagnostics") throw new Error('路径 "*" 只支持 diagnostics。');
			return runWorkspaceDiagnostics(cwd, signal, {
				...this.workspaceDiagnosticsOptions,
				...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
			});
		}
		const { projectRoot, filePath, adapter, workspaceRoot } = await this.resolveTarget(request, cwd);
		const client = await this.getClient(adapter, workspaceRoot, onStatus);
		const document = await client.openDocument(filePath);
		const maxResults = Math.min(MAX_RESULTS, Math.max(1, request.maxResults ?? DEFAULT_MAX_RESULTS));
		let formatted: FormattedResult;
		let changedFiles: string[] | undefined;

		switch (request.operation) {
			case "definition":
				formatted = formatLocations(
					await client.definition(document, resolveLspPosition(document, request), signal),
					projectRoot,
					maxResults,
				);
				break;
			case "references":
				formatted = formatLocations(
					await client.references(
						document,
						resolveLspPosition(document, request),
						request.includeDeclaration ?? true,
						signal,
					),
					projectRoot,
					maxResults,
				);
				break;
			case "implementation":
				formatted = formatLocations(
					await client.implementation(document, resolveLspPosition(document, request), signal),
					projectRoot,
					maxResults,
				);
				break;
			case "hover": {
				const text = hoverText(await client.hover(document, resolveLspPosition(document, request), signal));
				formatted = { text, count: text.startsWith("没有") ? 0 : 1, truncated: text.endsWith("[内容已截断]") };
				break;
			}
			case "symbols":
				formatted = formatDocumentSymbols(
					await client.documentSymbols(document, signal),
					filePath,
					projectRoot,
					maxResults,
				);
				break;
			case "workspace_symbols":
				if (!request.query?.trim()) throw new Error("workspace_symbols 需要 query。");
				formatted = formatWorkspaceSymbols(
					await client.workspaceSymbols(request.query.trim(), signal),
					projectRoot,
					maxResults,
				);
				break;
			case "diagnostics":
				formatted = formatDiagnostics(
					await client.diagnostics(document, signal),
					filePath,
					projectRoot,
					maxResults,
				);
				break;
			case "rename": {
				if (!request.newName?.trim()) throw new Error("rename 需要 new_name。");
				const workspaceEdit = await client.rename(
					document,
					resolveLspPosition(document, request),
					request.newName.trim(),
					signal,
				);
				if (!workspaceEdit) {
					formatted = { text: "语言服务器没有返回可应用的重命名编辑。", count: 0, truncated: false };
					break;
				}
				const applied = await applyWorkspaceEditSafely(workspaceEdit, projectRoot, {
					expectedContents: new Map([[filePath, document.text]]),
				});
				changedFiles = applied.changedFiles.map((changed) =>
					path.relative(projectRoot, changed).replaceAll("\\", "/"),
				);
				for (const changed of applied.changedFiles) await client.refreshOpenDocument(changed);
				formatted = {
					text: `重命名完成：修改 ${applied.changedFiles.length} 个文件，共 ${applied.editCount} 处。\n${changedFiles.join("\n")}`,
					count: applied.editCount,
					truncated: false,
				};
				break;
			}
		}

		return {
			text: formatted.text,
			details: {
				operation: request.operation,
				language: adapter.id,
				workspaceRoot,
				truncated: formatted.truncated,
				resultCount: formatted.count,
				...(changedFiles ? { changedFiles } : {}),
			},
		};
	}

	async stop(): Promise<void> {
		await Promise.all(
			[...this.clients.values()].map(async (clientPromise) => {
				try {
					await (await clientPromise).stop();
				} catch {
					// Failed startup promises and broken servers need no further cleanup.
				}
			}),
		);
		this.clients.clear();
	}

	private async resolveTarget(request: LspTargetRequest, cwd: string): Promise<ResolvedLspTarget> {
		const projectRoot = await realpath(cwd);
		const filePath = await realpath(path.resolve(projectRoot, request.path));
		if (!isPathInside(projectRoot, filePath)) throw new Error("LSP 只能读取当前项目中的文件。");
		const adapter = detectLanguageAdapter(filePath);
		if (!adapter) {
			if (request.symbol?.trim()) {
				throw new Error(
					`LSP 需要带扩展名的具体代码文件，不能使用“${request.path}”。当前只知道符号 ${request.symbol.trim()}，请先用内置 grep 搜索 "${request.symbol.trim()}"，找到具体文件和行号后再调用 lsp。`,
				);
			}
			throw new Error(`LSP 需要带扩展名的具体代码文件，不能使用“${request.path}”。请先用内置 grep 找到文件和行号。`);
		}
		return {
			projectRoot,
			filePath,
			adapter,
			workspaceRoot: await findLanguageWorkspaceRoot(filePath, projectRoot, adapter),
		};
	}

	private async getClient(
		adapter: LanguageAdapter,
		workspaceRoot: string,
		onStatus?: (message: string) => void,
	): Promise<LspClient> {
		const normalizedRoot = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
		const key = `${adapter.id}:${normalizedRoot}`;
		const previousFailure = this.startupFailures.get(key);
		if (previousFailure) throw new Error(previousFailure);
		let clientPromise = this.clients.get(key);
		if (!clientPromise) {
			onStatus?.(formatLanguageServerStartup(adapter));
			clientPromise = this.clientFactory(adapter, workspaceRoot);
			this.clients.set(key, clientPromise);
		}
		try {
			return await clientPromise;
		} catch (error) {
			this.clients.delete(key);
			const detail = error instanceof Error ? error.message : String(error);
			const message = `LSP 不可用：${detail}\n${formatLanguageServerSetup(adapter)}\n本次会话不再重复启动；请立即改用 grep 和 read。`;
			this.startupFailures.set(key, message);
			throw new Error(message);
		}
	}
}
