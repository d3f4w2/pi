import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { renderFileDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { AstEditService, type AstEditServiceLike } from "./edit.ts";
import { type AstGrepSearchService, AstGrepService } from "./search.ts";
import { AST_GREP_LANGUAGES, type AstEditDetails, type AstEditRequest, type AstGrepSearchDetails } from "./types.ts";

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

const AstEditParams = Type.Object(
	{
		pattern: Type.String({
			minLength: 1,
			maxLength: 1000,
			description: "要匹配的代码结构，例如 console.log($$$ARGS)",
		}),
		replacement: Type.String({
			maxLength: 20_000,
			description: "替换后的代码；可复用 pattern 中的 $NAME 或 $$$ARGS，空字符串表示删除",
		}),
		language: Type.Optional(
			Type.Union(
				AST_GREP_LANGUAGES.map((language) => Type.Literal(language)),
				{ default: "auto", description: "默认 auto，自动处理支持的代码文件" },
			),
		),
		path: Type.Optional(
			Type.String({ minLength: 1, maxLength: 4096, description: "要修改的文件或文件夹，默认当前项目" }),
		),
		max_matches: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 1000, description: "安全上限，默认最多修改 100 处" }),
		),
	},
	{ additionalProperties: false },
);

type AstEditParamsType = Static<typeof AstEditParams>;

interface AstEditRenderState {
	component?: AstEditCallComponent;
}

type AstEditCallComponent = Box & {
	argsKey?: string;
	pending?: boolean;
	preview?: AstEditDetails;
	error?: string;
};

function createAstEditCallComponent(): AstEditCallComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		argsKey: undefined as string | undefined,
		pending: false,
		preview: undefined as AstEditDetails | undefined,
		error: undefined as string | undefined,
	});
}

function toEditRequest(params: AstEditParamsType): AstEditRequest {
	return {
		pattern: params.pattern,
		replacement: params.replacement,
		language: params.language ?? "auto",
		...(params.path === undefined ? {} : { path: params.path }),
		...(params.max_matches === undefined ? {} : { maxMatches: params.max_matches }),
	};
}

function renderAstEditComponent(
	component: AstEditCallComponent,
	params: AstEditParamsType | undefined,
	theme: Theme,
	expanded: boolean,
): AstEditCallComponent {
	component.setBgFn((text: string) =>
		component.error
			? theme.bg("toolErrorBg", text)
			: component.preview
				? theme.bg("toolSuccessBg", text)
				: theme.bg("toolPendingBg", text),
	);
	component.clear();
	const path = params?.path ?? ".";
	component.addChild(new Text(`${theme.fg("toolTitle", theme.bold("ast_edit"))} ${theme.fg("muted", path)}`, 0, 0));
	if (component.error) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("error", component.error), 0, 0));
		return component;
	}
	if (!component.preview) return component;

	component.addChild(new Spacer(1));
	component.addChild(
		new Text(
			theme.fg(
				"muted",
				`预览 ${component.preview.changedFileCount} 个文件 · ${component.preview.matchCount} 处 · +${component.preview.additions} -${component.preview.deletions}`,
			),
			0,
			0,
		),
	);
	const visibleDiffs = expanded ? component.preview.diffs : component.preview.diffs.slice(0, 6);
	const perFileLimit = expanded ? Number.POSITIVE_INFINITY : Math.max(12, Math.floor(72 / visibleDiffs.length));
	for (const diff of visibleDiffs) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(renderFileDiff(diff, { expanded, maxLines: perFileLimit }), 0, 0));
	}
	const hiddenFiles = component.preview.diffs.length - visibleDiffs.length;
	if (hiddenFiles > 0) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("muted", `… 另有 ${hiddenFiles} 个文件，展开工具输出可查看`), 0, 0));
	}
	return component;
}

function registerAstGrepExtension(
	pi: ExtensionAPI,
	service: AstGrepSearchService,
	editService: AstEditServiceLike,
): void {
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

	pi.registerTool<typeof AstEditParams, AstEditDetails, AstEditRenderState>({
		name: "ast_edit",
		label: "代码结构修改",
		description: "按代码结构精确批量修改。会先生成 Diff，全部验证通过后再写入。",
		discovery: {
			keywords: ["批量改代码", "结构替换", "重写调用", "ast edit", "structural rewrite"],
			companionTools: ["lsp", "verify"],
		},
		promptSnippet: "按语法结构安全地批量修改重复代码",
		promptGuidelines: [
			"只有同一种代码结构需要跨多处修改时才使用 ast_edit；单文件单处修改使用 edit。",
			"先用 ast_grep 确认 pattern，或在结构非常明确时直接调用 ast_edit；不要用 bash 拼接批量替换命令。",
			"replacement 可复用 pattern 捕获的 $NAME 或 $$$ARGS；不要改变不相关的格式和代码。",
			"ast_edit 失败、超时或超限时立即缩小 path 或改用 edit，不要用相同参数重复调用。",
		],
		parameters: AstEditParams,
		executionMode: "sequential",
		approval: { tier: "write", reason: "批量修改代码文件" },
		formatApprovalDetails: (args) => {
			const params = args as Partial<AstEditParamsType>;
			return [`范围：${params.path ?? "."}`, `匹配：${params.pattern ?? ""}`, `替换：${params.replacement ?? ""}`];
		},
		renderShell: "self",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [{ type: "text", text: `正在准备 ${params.path ?? "."} 的结构化修改…` }],
				details: {
					language: params.language ?? "auto",
					path: params.path ?? ".",
					changedFileCount: 0,
					changedFiles: [],
					matchCount: 0,
					additions: 0,
					deletions: 0,
					durationMs: 0,
					diffs: [],
				},
			});
			const result = await editService.edit(toEditRequest(params), ctx.cwd, signal);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
		renderCall(params, theme, context) {
			const component =
				(context.lastComponent as AstEditCallComponent | undefined) ??
				context.state.component ??
				createAstEditCallComponent();
			context.state.component = component;
			const argsKey = context.argsComplete ? JSON.stringify(params) : undefined;
			if (component.argsKey !== argsKey) {
				component.argsKey = argsKey;
				component.pending = false;
				component.preview = undefined;
				component.error = undefined;
			}
			if (context.argsComplete && !component.pending && !component.preview && !component.error) {
				component.pending = true;
				const requestKey = argsKey;
				void editService
					.preview(toEditRequest(params), context.cwd)
					.then((result) => {
						if (component.argsKey !== requestKey) return;
						component.preview = result.details;
						component.pending = false;
						renderAstEditComponent(component, params, theme, context.expanded);
						context.invalidate();
					})
					.catch((error: unknown) => {
						if (component.argsKey !== requestKey) return;
						component.error = error instanceof Error ? error.message : String(error);
						component.pending = false;
						renderAstEditComponent(component, params, theme, context.expanded);
						context.invalidate();
					});
			}
			return renderAstEditComponent(component, params, theme, context.expanded);
		},
		renderResult(result, _options, theme, context) {
			const component = context.state.component;
			if (component && context.isError) {
				component.error = result.content.find((item) => item.type === "text")?.text ?? "ast_edit 执行失败";
				renderAstEditComponent(component, context.args, theme, context.expanded);
			} else if (component && result.details) {
				component.preview = result.details;
				component.error = undefined;
				renderAstEditComponent(component, context.args, theme, context.expanded);
			}
			const output = (context.lastComponent as Container | undefined) ?? new Container();
			output.clear();
			if (context.isError && !component) {
				const message = result.content.find((item) => item.type === "text")?.text;
				if (message) output.addChild(new Text(theme.fg("error", message), 1, 0));
			}
			return output;
		},
	});
}

export function createAstGrepExtension(
	service: AstGrepSearchService,
	editService: AstEditServiceLike = new AstEditService(),
): (pi: ExtensionAPI) => void {
	return (pi) => registerAstGrepExtension(pi, service, editService);
}

export default function astGrepExtension(pi: ExtensionAPI): void {
	registerAstGrepExtension(pi, new AstGrepService(), new AstEditService());
}
