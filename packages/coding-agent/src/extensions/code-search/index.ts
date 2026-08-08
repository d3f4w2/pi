import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { formatMgrepError } from "./process.ts";
import { CodeSearchService } from "./search.ts";

const CodeSearchParams = Type.Object(
	{
		query: Type.String({ minLength: 2, maxLength: 500, description: "用自然语言描述要找的代码或功能" }),
		path: Type.Optional(
			Type.String({ maxLength: 4096, description: "只返回这个文件或文件夹中的结果；普通项目仍会完整索引" }),
		),
		max_results: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 20,
				description: "最多返回几条结果；首轮默认 6 条，可按需增加到 12 或 20 条",
			}),
		),
	},
	{ additionalProperties: false },
);

export default function codeSearchExtension(pi: ExtensionAPI): void {
	const service = new CodeSearchService();

	pi.registerTool({
		name: "code_search",
		label: "语义代码搜索",
		description: "按意思搜索当前项目中的代码，返回最相关的文件、行号和代码片段。",
		promptSnippet: "按自然语言描述快速找到相关代码",
		promptGuidelines: [
			"当前上下文已经足够回答时直接回答，不要为了验证而调用任何搜索工具。",
			"知道准确路径时用 read；知道准确符号、文字、报错或配置键时用 grep；询问 API Key 等配置位置时不要使用 code_search。",
			"只有准确路径、符号和关键词都未知，并且需要按功能或行为意图探索代码时，才使用 code_search。",
			"使用 code_search 时用包含动作和关系的完整意图搜索，不要只输入宽泛关键词；首轮默认返回 6 条结果。",
			"检查结果能否组成定义、加载或注册、调用或消费的完整证据链；缺少环节时换一种描述再次搜索，或把 max_results 依次增加到 12、20。",
			"索引未就绪或 code_search 失败时立即使用内置 grep 继续，不要等待或立即重试，也不要通过 bash 运行 rg。",
			"最后用 read 读取相关行附近的小范围代码；证据仍然不足时再扩大读取范围。",
		],
		parameters: CodeSearchParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				const result = await service.search(
					{
						query: params.query,
						...(params.path === undefined ? {} : { path: params.path }),
						...(params.max_results === undefined ? {} : { maxResults: params.max_results }),
					},
					ctx.cwd,
					signal,
					(message, stage, elapsedMs) =>
						onUpdate?.({
							content: [{ type: "text", text: message }],
							details: {
								stage,
								query: params.query,
								path: params.path ?? ".",
								durationMs: elapsedMs,
								firstIndex: stage === "indexing",
								truncated: false,
							},
						}),
				);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			} catch (error) {
				throw new Error(formatMgrepError(error));
			}
		},
	});

	pi.on("session_shutdown", () => service.stop());
}
