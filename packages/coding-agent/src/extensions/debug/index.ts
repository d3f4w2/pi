import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { DebugSessionService, inferDebugLanguage } from "./service.ts";
import type { DebugLanguage, DebugOperation, DebugServiceLike, DebugToolDetails } from "./types.ts";

const OPERATIONS = [
	"start",
	"attach",
	"set_breakpoints",
	"set_function_breakpoints",
	"set_exception_breakpoints",
	"data_breakpoint_info",
	"set_data_breakpoints",
	"threads",
	"pause",
	"continue",
	"next",
	"step_in",
	"step_out",
	"stack",
	"scopes",
	"variables",
	"evaluate",
	"loaded_sources",
	"modules",
	"restart",
	"status",
	"disconnect",
	"stop",
] as const;

const DebugParams = Type.Object(
	{
		operation: Type.Union(
			OPERATIONS.map((operation) => Type.Literal(operation)),
			{ description: "调试操作" },
		),
		language: Type.Optional(
			Type.Union([Type.Literal("python"), Type.Literal("javascript"), Type.Literal("go")], {
				description: "start 的语言；通常可从 path 推断",
			}),
		),
		path: Type.Optional(Type.String({ maxLength: 4096, description: "程序或断点文件，必须位于当前项目" })),
		lines: Type.Optional(
			Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 100, description: "start 或 set_breakpoints 的行号" }),
		),
		args: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 50, description: "程序参数" })),
		stop_on_entry: Type.Optional(Type.Boolean({ description: "是否在程序入口暂停，默认 false" })),
		process_id: Type.Optional(Type.Integer({ minimum: 1, description: "attach 使用的进程 PID" })),
		host: Type.Optional(Type.String({ minLength: 1, maxLength: 253, description: "attach 的调试服务器地址" })),
		port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535, description: "attach 的调试服务器端口" })),
		thread_id: Type.Optional(Type.Integer({ minimum: 1, description: "线程或 Go 协程 ID" })),
		frame_id: Type.Optional(Type.Integer({ minimum: 0, description: "stack 返回的 frame ID" })),
		variables_reference: Type.Optional(Type.Integer({ minimum: 0, description: "scopes/variables 返回的变量引用" })),
		expression: Type.Optional(Type.String({ maxLength: 10_000, description: "evaluate 要计算的表达式" })),
		function_names: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
				maxItems: 100,
				description: "函数断点名称",
			}),
		),
		exception_filters: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
				maxItems: 100,
				description: "异常过滤器 ID",
			}),
		),
		data_ids: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
				maxItems: 100,
				description: "data_breakpoint_info 返回的数据 ID",
			}),
		),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000, description: "数据断点变量名" })),
		condition: Type.Optional(Type.String({ maxLength: 2_000, description: "断点条件" })),
		hit_condition: Type.Optional(Type.String({ maxLength: 200, description: "命中次数条件" })),
		log_message: Type.Optional(Type.String({ maxLength: 2_000, description: "日志点消息；不中断程序" })),
		access_type: Type.Optional(Type.String({ maxLength: 100, description: "数据断点访问类型" })),
	},
	{ additionalProperties: false },
);

const READ_OPERATIONS = new Set<DebugOperation>([
	"threads",
	"stack",
	"scopes",
	"variables",
	"data_breakpoint_info",
	"loaded_sources",
	"modules",
	"status",
]);
const MAX_DEBUG_OUTPUT_BYTES = 24 * 1024;

export function capDebugResult(result: { text: string; details: DebugToolDetails }): {
	text: string;
	details: DebugToolDetails;
} {
	const bytes = Buffer.from(result.text, "utf8");
	if (bytes.length <= MAX_DEBUG_OUTPUT_BYTES) return result;
	let text = new TextDecoder().decode(bytes.subarray(0, MAX_DEBUG_OUTPUT_BYTES));
	if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
	return { text: `${text}\n[调试输出已截断]`, details: { ...result.details, truncated: true } };
}

export function createDebugExtension(service: DebugServiceLike): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool<typeof DebugParams, DebugToolDetails>({
			name: "debug",
			label: "DAP 调试器",
			description: "启动或附加调试器，控制线程、断点、单步、调用栈和变量。",
			discovery: {
				keywords: ["调试代码", "设置断点", "单步执行", "查看变量", "调用栈", "debug program", "breakpoint"],
			},
			promptSnippet: "遇到只能在运行时复现的问题时，用 DAP 断点和变量证据定位原因",
			promptGuidelines: [
				"只有静态阅读、LSP 和相关测试不足以定位运行时问题时才使用 debug。",
				"新程序使用 start，已有进程或调试端口使用 attach；暂停后按 threads → stack → scopes → variables 检查。",
				"普通行断点用 set_breakpoints；只有问题需要时才使用条件、命中次数、日志点、函数、异常或数据断点。",
				"附加会话完成后优先 disconnect，让目标继续运行；只有明确要终止目标时才 stop。",
				"修改代码前先用调试证据确认根因；修复后用 verify 验证，不要把调试器当测试工具。",
				"适配器缺失时按提示安装并继续其他工作，不要循环启动。",
			],
			parameters: DebugParams,
			executionMode: "sequential",
			approval: (args) => {
				const operation =
					typeof args === "object" && args !== null && "operation" in args ? args.operation : undefined;
				return READ_OPERATIONS.has(operation as DebugOperation)
					? { tier: "read", reason: "读取当前调试会话状态" }
					: { tier: "exec", reason: "控制本机调试器和被调试程序" };
			},
			formatApprovalDetails: (args) => {
				const params = args as { operation?: string; path?: string };
				return [`操作：${params.operation ?? "unknown"}`, ...(params.path ? [`目标：${params.path}`] : [])];
			},
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (params.operation === "start") {
					if (!params.path) throw new Error("start 需要 path。");
					const language: DebugLanguage = params.language ?? inferDebugLanguage(params.path);
					const result = capDebugResult(
						await service.start(
							{
								language,
								path: params.path,
								args: params.args ?? [],
								breakpoints: params.lines ?? [],
								stopOnEntry: params.stop_on_entry ?? false,
								cwd: ctx.cwd,
							},
							signal,
						),
					);
					return { content: [{ type: "text", text: result.text }], details: result.details };
				}
				if (params.operation === "attach") {
					if (!params.language && !params.path) throw new Error("attach 没有 path 时需要 language。");
					const language: DebugLanguage = params.language ?? inferDebugLanguage(params.path ?? "");
					const result = capDebugResult(
						await service.attach(
							{
								language,
								...(params.path === undefined ? {} : { path: params.path }),
								...(params.process_id === undefined ? {} : { processId: params.process_id }),
								...(params.host === undefined ? {} : { host: params.host }),
								...(params.port === undefined ? {} : { port: params.port }),
								breakpoints: params.lines ?? [],
								cwd: ctx.cwd,
							},
							signal,
						),
					);
					return { content: [{ type: "text", text: result.text }], details: result.details };
				}
				const result = capDebugResult(
					await service.action(
						{
							operation: params.operation,
							...(params.path === undefined ? {} : { path: params.path }),
							...(params.lines === undefined ? {} : { lines: params.lines }),
							...(params.thread_id === undefined ? {} : { threadId: params.thread_id }),
							...(params.frame_id === undefined ? {} : { frameId: params.frame_id }),
							...(params.variables_reference === undefined
								? {}
								: { variablesReference: params.variables_reference }),
							...(params.expression === undefined ? {} : { expression: params.expression }),
							...(params.function_names === undefined ? {} : { functionNames: params.function_names }),
							...(params.exception_filters === undefined ? {} : { exceptionFilters: params.exception_filters }),
							...(params.data_ids === undefined ? {} : { dataIds: params.data_ids }),
							...(params.name === undefined ? {} : { name: params.name }),
							...(params.condition === undefined ? {} : { condition: params.condition }),
							...(params.hit_condition === undefined ? {} : { hitCondition: params.hit_condition }),
							...(params.log_message === undefined ? {} : { logMessage: params.log_message }),
							...(params.access_type === undefined ? {} : { accessType: params.access_type }),
						},
						ctx.cwd,
						signal,
					),
				);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		});
		pi.on("session_shutdown", () => service.stop());
	};
}

export default createDebugExtension(new DebugSessionService());
