import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type AstGrepSearchService, AstGrepService } from "./search.ts";
import { AST_GREP_LANGUAGES, type AstGrepSearchDetails } from "./types.ts";

const AstGrepParams = Type.Object(
	{
		pattern: Type.String({
			minLength: 1,
			maxLength: 1000,
			description: "要匹配的代码结构，例如 console.log($$$ARGS)",
		}),
		language: Type.Optional(
			Type.Union(
				AST_GREP_LANGUAGES.map((language) => Type.Literal(language)),
				{
					default: "auto",
					description: "可省略；默认 auto，一次自动搜索所有支持的代码文件",
				},
			),
		),
		path: Type.Optional(
			Type.String({ minLength: 1, maxLength: 4096, description: "只搜索这个文件或文件夹，默认当前项目" }),
		),
		max_results: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 1000,
				description: "最多返回几条；默认 100，用户明确要求全部时使用 1000",
			}),
		),
	},
	{ additionalProperties: false },
);

function registerAstGrepExtension(pi: ExtensionAPI, service: AstGrepSearchService): void {
	pi.registerTool<typeof AstGrepParams, AstGrepSearchDetails>({
		name: "ast_grep",
		label: "代码结构搜索",
		description: "按代码结构精确搜索，能分清真正的代码、注释和字符串。",
		discovery: {
			keywords: ["代码结构", "语法结构", "结构搜索", "调用写法", "ast grep", "structural code search"],
		},
		promptSnippet: "按语法结构精确查找重复的代码写法",
		promptGuidelines: [
			"当前上下文足够时直接回答，不要为了验证而调用搜索工具。",
			"已知准确文字、报错或配置键时使用 grep；只有需要按语法结构查找代码写法时才使用 ast_grep。",
			"查定义、引用、类型和错误时使用 lsp；按功能意图探索未知代码时使用 code_search。",
			"单个节点用 $NAME，多段参数或语句用 $$$ARGS；pattern 必须是所选语言中的合法代码结构。",
			"language 默认使用 auto，一次搜索所有支持的文件；不要按 JavaScript、TypeScript、TSX 分别重复调用。",
			"用户明确要求所有或全部结果时，一次调用并设置 max_results=1000；结果仍被限制时再按 path 缩小，不要先按包重复扫描。",
			"调用 ast_grep 前后不要调用 bash、环境变量、目录列表或其他工具来辅助枚举文件；ast_grep 自己负责扫描 path。",
			"ast_grep 失败、超时或范围过大时立即改用 grep 和 read，不要在同一任务中重复调用。",
			"找到位置后只用 read 读取必要的附近代码。",
		],
		parameters: AstGrepParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await service.search(
				{
					pattern: params.pattern,
					language: params.language ?? "auto",
					...(params.path === undefined ? {} : { path: params.path }),
					...(params.max_results === undefined ? {} : { maxResults: params.max_results }),
				},
				ctx.cwd,
				signal,
				(message) =>
					onUpdate?.({
						content: [{ type: "text", text: message }],
						details: {
							language: params.language ?? "auto",
							path: params.path ?? ".",
							resultCount: 0,
							scannedFiles: 0,
							skippedFiles: 0,
							truncated: false,
							outputTruncated: false,
							durationMs: 0,
						},
					}),
			);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});
}

export function createAstGrepExtension(service: AstGrepSearchService): (pi: ExtensionAPI) => void {
	return (pi) => registerAstGrepExtension(pi, service);
}

export default function astGrepExtension(pi: ExtensionAPI): void {
	registerAstGrepExtension(pi, new AstGrepService());
}
