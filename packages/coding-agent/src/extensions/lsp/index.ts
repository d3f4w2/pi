import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { LspAutoDiagnostics, type LspAutoDiagnosticsOptions } from "./auto-diagnostics.ts";
import { detectLanguageAdapter } from "./languages.ts";
import { LspService } from "./service.ts";
import type { LspToolRequest, LspToolResult } from "./types.ts";

const LspParams = Type.Object(
	{
		operation: Type.Union(
			[
				Type.Literal("definition"),
				Type.Literal("references"),
				Type.Literal("implementation"),
				Type.Literal("hover"),
				Type.Literal("symbols"),
				Type.Literal("workspace_symbols"),
				Type.Literal("diagnostics"),
				Type.Literal("rename"),
			],
			{ description: "要执行的代码理解操作" },
		),
		path: Type.String({
			minLength: 1,
			maxLength: 4096,
			description: '当前项目中带扩展名的具体代码文件；diagnostics 使用 "*" 检查整个项目',
		}),
		line: Type.Optional(Type.Integer({ minimum: 1, description: "从 1 开始的行号" })),
		column: Type.Optional(Type.Integer({ minimum: 1, description: "从 1 开始的列号" })),
		symbol: Type.Optional(
			Type.String({ minLength: 1, maxLength: 300, description: "已知文件内的准确符号名，可代替列号" }),
		),
		query: Type.Optional(Type.String({ maxLength: 300, description: "workspace_symbols 使用的符号关键词" })),
		new_name: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "rename 使用的新名称" })),
		include_declaration: Type.Optional(Type.Boolean({ description: "references 是否包含定义位置，默认包含" })),
		max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "最多返回多少条，默认 50 条" })),
	},
	{ additionalProperties: false },
);

interface LspToolService {
	warmup?(filePath: string, cwd: string, onStatus?: (message: string) => void): Promise<void>;
	execute(
		request: LspToolRequest,
		cwd: string,
		signal?: AbortSignal,
		onStatus?: (message: string) => void,
	): Promise<LspToolResult>;
	stop(): Promise<void>;
}

function registerLspExtension(
	pi: ExtensionAPI,
	service: LspToolService,
	autoDiagnosticsOptions?: LspAutoDiagnosticsOptions,
): void {
	const autoDiagnostics = new LspAutoDiagnostics(service, autoDiagnosticsOptions);
	pi.registerTool<typeof LspParams, LspToolResult["details"]>({
		name: "lsp",
		label: "代码关系与诊断",
		description: "准确查询定义、引用、类型、错误（单文件或整个项目），并按语言规则安全重命名。",
		promptSnippet: "已知具体代码文件后，用语言服务器准确理解代码关系和错误",
		promptGuidelines: [
			"当前上下文已经足够回答时直接回答，不要为了验证而调用工具。",
			"已知准确文字、报错或配置键时使用 grep；路径、符号和关键词都未知且需要按功能意图探索时使用 code_search。",
			'只知道 symbol 但不知道所在文件时，先用 grep 找到具体文件和行号，再调用 lsp；只有 diagnostics 可以把 "*" 作为 path。',
			"需要确认定义、引用、实现、类型、文件结构、语言诊断或安全重命名时使用 lsp。",
			'需要检查整个 TypeScript、Python 或 Go 项目时，使用 diagnostics 和 path="*"；不要改用 shell 执行相同检查。',
			"line 和 column 都从 1 开始；知道准确 symbol 时可以用 symbol 代替 column，出现多次后再补 line。",
			"LSP 未安装、未就绪、超时或失败时立即改用 grep 和 read，不要等待或在同一任务中重复调用。",
			"一批代码修改完成后会自动检查相关文件；有诊断时优先修复本次修改引入的问题，不要反复检查整个项目。",
			"rename 会直接修改文件；完成后检查 Git diff，并运行相关诊断或测试。",
		],
		parameters: LspParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const language = detectLanguageAdapter(params.path)?.id ?? "unknown";
			const result = await service.execute(
				{
					operation: params.operation,
					path: params.path,
					...(params.line === undefined ? {} : { line: params.line }),
					...(params.column === undefined ? {} : { column: params.column }),
					...(params.symbol === undefined ? {} : { symbol: params.symbol }),
					...(params.query === undefined ? {} : { query: params.query }),
					...(params.new_name === undefined ? {} : { newName: params.new_name }),
					...(params.include_declaration === undefined ? {} : { includeDeclaration: params.include_declaration }),
					...(params.max_results === undefined ? {} : { maxResults: params.max_results }),
				},
				ctx.cwd,
				signal,
				(message) =>
					onUpdate?.({
						content: [{ type: "text", text: message }],
						details: {
							operation: params.operation,
							language,
							workspaceRoot: ctx.cwd,
							truncated: false,
							resultCount: 0,
						},
					}),
			);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.on("agent_start", () => autoDiagnostics.resetRun());
	pi.on("tool_result", (event, ctx) => {
		if (!pi.getActiveTools().includes("lsp")) return;
		autoDiagnostics.recordToolResult(event, {
			cwd: ctx.cwd,
			onStatus: (message) => ctx.ui.notify(message, "info"),
		});
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (!pi.getActiveTools().includes("lsp")) {
			autoDiagnostics.discardPending();
			return;
		}
		if (autoDiagnostics.pendingFileCount === 0) return;
		ctx.ui.setStatus("lsp-auto-diagnostics", `LSP 正在检查 ${autoDiagnostics.pendingFileCount} 个修改文件…`);
		try {
			const result = await autoDiagnostics.flush(ctx.cwd, ctx.signal, (message) => ctx.ui.notify(message, "info"));
			if (result.notice) ctx.ui.notify(result.notice, "warning");
			if (result.kind !== "diagnostics" || !result.message) return;
			pi.sendMessage(
				{
					customType: "lsp-auto-diagnostics",
					content: result.message,
					display: true,
					details: {
						checkedFiles: result.checkedFiles,
						diagnosticCount: result.diagnosticCount,
					},
				},
				{ deliverAs: "steer" },
			);
		} finally {
			ctx.ui.setStatus("lsp-auto-diagnostics", undefined);
		}
	});
	pi.on("session_shutdown", () => service.stop());
}

export function createLspExtension(
	service: LspToolService,
	autoDiagnosticsOptions?: LspAutoDiagnosticsOptions,
): (pi: ExtensionAPI) => void {
	return (pi) => registerLspExtension(pi, service, autoDiagnosticsOptions);
}

export default function lspExtension(pi: ExtensionAPI): void {
	registerLspExtension(pi, new LspService());
}
