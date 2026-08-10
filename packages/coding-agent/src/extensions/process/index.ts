import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "../../core/extensions/types.ts";
import { BackgroundProcessManager } from "./manager.ts";
import type { BackgroundProcessService, ManagedProcessInfo, ProcessOperation, ProcessToolDetails } from "./types.ts";
import { type ProcessManagerResult, showProcessLogs, showProcessManager } from "./ui.ts";

const ProcessParams = Type.Union([
	Type.Object(
		{
			operation: Type.Literal("start"),
			command: Type.String({ minLength: 1, maxLength: 4_096, description: "可执行文件，例如 npm、node 或完整路径" }),
			args: Type.Optional(
				Type.Array(Type.String({ maxLength: 10_000 }), { maxItems: 100, description: "直接传给程序的参数数组" }),
			),
			cwd: Type.Optional(Type.String({ maxLength: 4_096, description: "项目内工作目录，默认当前目录" })),
			label: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "便于识别的短名称" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("status"),
			id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("logs"),
			id: Type.String({ minLength: 1, maxLength: 100 }),
			cursor: Type.Optional(Type.Integer({ minimum: 0, description: "上次返回的 next_cursor；只读取新增日志" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("input"),
			id: Type.String({ minLength: 1, maxLength: 100 }),
			data: Type.String({ maxLength: 65_536, description: "写入进程标准输入的文本" }),
			append_newline: Type.Optional(Type.Boolean({ description: "末尾追加换行，默认 true" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("restart"), id: Type.String({ minLength: 1, maxLength: 100 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("stop"), id: Type.String({ minLength: 1, maxLength: 100 }) },
		{ additionalProperties: false },
	),
]);

function operationOf(args: unknown): ProcessOperation | "unknown" {
	if (typeof args !== "object" || args === null || !("operation" in args)) return "unknown";
	const operation = Reflect.get(args, "operation");
	return operation === "start" ||
		operation === "status" ||
		operation === "logs" ||
		operation === "input" ||
		operation === "restart" ||
		operation === "stop"
		? operation
		: "unknown";
}

function formatProcess(processInfo: ManagedProcessInfo): string {
	const pid = processInfo.pid === undefined ? "" : ` · PID ${processInfo.pid}`;
	const urls = processInfo.urls.length === 0 ? "" : `\n地址：${processInfo.urls.join("、")}`;
	const error = processInfo.error ? `\n错误：${processInfo.error}` : "";
	return `${processInfo.id} · ${processInfo.label} · ${processInfo.state}${pid}\n目录：${processInfo.cwd}${urls}${error}`;
}

function formatStatus(processes: readonly ManagedProcessInfo[]): string {
	return processes.length === 0 ? "当前没有托管进程。" : processes.map(formatProcess).join("\n\n");
}

export function parseDirectCommandLine(value: string): { command: string; args: string[] } {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let started = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index] ?? "";
		if (quote) {
			if (character === quote) {
				quote = undefined;
				continue;
			}
			if (character === "\\" && (value[index + 1] === quote || value[index + 1] === "\\")) {
				current += value[++index] ?? "";
				continue;
			}
			current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		if (character === "\\" && /[\s'"\\]/.test(value[index + 1] ?? "")) {
			current += value[++index] ?? "";
			started = true;
			continue;
		}
		current += character;
		started = true;
	}
	if (quote) throw new Error("启动命令中的引号没有闭合。");
	if (started) tokens.push(current);
	const [command, ...args] = tokens;
	if (!command) throw new Error("启动命令不能为空。");
	return { command, args };
}

async function processCommand(service: BackgroundProcessService, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const operation = await ctx.ui.select("后台进程", ["启动进程", "管理进程", "关闭"]);
		if (operation === undefined || operation === "关闭") return;
		if (operation === "启动进程") {
			const line = await ctx.ui.input("启动命令", "例如：npm run dev");
			if (!line?.trim()) continue;
			try {
				const parsed = parseDirectCommandLine(line);
				const processInfo = await service.start({ ...parsed, cwd: ctx.cwd }, ctx.cwd, ctx.signal);
				ctx.ui.notify(`已在后台启动：${processInfo.id} · ${processInfo.label}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			continue;
		}
		try {
			const result = await ctx.ui.custom<ProcessManagerResult>(async (tui, theme, keybindings, done) =>
				showProcessManager(
					await service.status(),
					tui,
					theme,
					keybindings,
					async (action, id) => {
						if (action === "stop") await service.stop(id);
						else await service.restart(id, ctx.signal);
						return service.status();
					},
					(message) => ctx.ui.notify(message, "error"),
					done,
				),
			);
			if (result.type === "logs") {
				const logs = await service.logs(result.id);
				await ctx.ui.custom<void>((_tui, _theme, keybindings, done) =>
					showProcessLogs(logs.text, keybindings, done),
				);
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
}

function registerProcessExtension(pi: ExtensionAPI, service: BackgroundProcessService): void {
	const definition: ToolDefinition<typeof ProcessParams, ProcessToolDetails> = {
		name: "process",
		label: "后台进程",
		description: "启动和管理开发服务器等长期运行的项目进程，并增量读取日志。",
		discovery: {
			keywords: ["启动服务", "后台进程", "开发服务器", "查看服务日志", "重启服务", "dev server", "process logs"],
		},
		promptSnippet: "在后台启动开发服务，增量读取日志，并安全停止或重启",
		promptGuidelines: [
			"需要启动不会自动退出的开发服务器、监听器或测试观察模式时使用 process，不要让 bash 长时间等待。",
			"start 使用可执行文件和参数数组，不要把整条 Shell 命令放进 command。",
			"读取日志后保存 next_cursor，后续只读取新增日志，避免重复消耗上下文。",
			"只停止 process 返回的逻辑 ID，不要查找或终止用户的其他进程。",
		],
		parameters: ProcessParams,
		executionMode: "sequential",
		approval: (args) =>
			operationOf(args) === "status" || operationOf(args) === "logs"
				? { tier: "read", reason: "读取托管进程状态或日志" }
				: { tier: "exec", reason: "启动、停止或重启本会话创建的进程" },
		formatApprovalDetails: (args) => {
			if (typeof args !== "object" || args === null) return [];
			const command = Reflect.get(args, "command");
			const id = Reflect.get(args, "id");
			return [
				`操作：${operationOf(args)}`,
				...(typeof command === "string" ? [`程序：${command}`] : []),
				...(typeof id === "string" ? [`进程：${id}`] : []),
			];
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.operation === "start") {
				const processInfo = await service.start(
					{
						command: params.command,
						args: params.args ?? [],
						cwd: params.cwd ?? ctx.cwd,
						...(params.label === undefined ? {} : { label: params.label }),
					},
					ctx.cwd,
					signal,
				);
				return {
					content: [{ type: "text", text: `已在后台启动。\n${formatProcess(processInfo)}` }],
					details: { operation: "start", process: processInfo },
				};
			}
			if (params.operation === "status") {
				const processes = await service.status(params.id);
				return {
					content: [{ type: "text", text: formatStatus(processes) }],
					details: { operation: "status", processes },
				};
			}
			if (params.operation === "logs") {
				const logs = await service.logs(params.id, params.cursor);
				const suffix = `\n[next_cursor: ${logs.nextCursor} · state: ${logs.state}${logs.truncated ? " · 已截断" : ""}]`;
				return {
					content: [{ type: "text", text: `${logs.text || "没有新增日志。"}${suffix}` }],
					details: { operation: "logs", logs },
				};
			}
			if (params.operation === "input") {
				const data = params.append_newline === false ? params.data : `${params.data}\n`;
				const processInfo = await service.input(params.id, data);
				return {
					content: [{ type: "text", text: `已向 ${params.id} 写入 ${Buffer.byteLength(data, "utf8")} 字节。` }],
					details: { operation: "input", process: processInfo, bytes: Buffer.byteLength(data, "utf8") },
				};
			}
			if (params.operation === "restart") {
				const processInfo = await service.restart(params.id, signal);
				return {
					content: [{ type: "text", text: `已重启。\n${formatProcess(processInfo)}` }],
					details: { operation: "restart", process: processInfo },
				};
			}
			const processInfo = await service.stop(params.id);
			return {
				content: [{ type: "text", text: `已停止。\n${formatProcess(processInfo)}` }],
				details: { operation: "stop", process: processInfo },
			};
		},
	};
	pi.registerTool(definition);
	pi.registerCommand("process", {
		description: "启动或管理后台开发进程",
		handler: async (_args, ctx) => processCommand(service, ctx),
	});
	pi.on("session_shutdown", () => service.stopAll());
}

export function createProcessExtension(service: BackgroundProcessService): (pi: ExtensionAPI) => void {
	return (pi) => registerProcessExtension(pi, service);
}

export default createProcessExtension(new BackgroundProcessManager());
