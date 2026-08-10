import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { VerifyDetails, VerifyToolService } from "./types.ts";

const VerifyParams = Type.Object(
	{
		operation: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("typecheck"), Type.Literal("test"), Type.Literal("lint")], {
				default: "auto",
				description: "默认 auto：类型检查后只运行能安全定位的相关测试",
			}),
		),
		path: Type.Optional(
			Type.String({ minLength: 1, maxLength: 4096, description: "要验证的文件或项目目录，默认当前项目" }),
		),
		timeout: Type.Optional(
			Type.Integer({ minimum: 5, maximum: 300, description: "每项检查最多运行多少秒，默认 60 秒" }),
		),
	},
	{ additionalProperties: false },
);

type VerifyServiceLoader = () => Promise<VerifyToolService>;

function registerVerifyExtension(pi: ExtensionAPI, loadService: VerifyServiceLoader): void {
	pi.registerTool<typeof VerifyParams, VerifyDetails>({
		name: "verify",
		label: "代码验证",
		description: "自动运行类型检查、相关测试和 lint，并只返回关键结果。",
		discovery: {
			keywords: ["检查修改", "验证代码", "类型检查", "运行测试", "代码规范", "verify code", "typecheck"],
		},
		promptSnippet: "修改代码后，用最小范围的检查和测试证明结果正确",
		promptGuidelines: [
			"只回答问题、读取代码、修改文档或注释时不要调用 verify。",
			"任何 write 或 edit 之后，只要用户要求检查、验证、确认正确或测试刚写的代码，就必须先使用 operation=auto；“检查刚才的修改”不应只调用 read。只有用户明确要求查看文件内容时才只用 read。",
			"完成一批有行为影响的代码修改后，使用 operation=auto，并把 path 指向最相关的修改文件或包。",
			"auto 先做类型检查，只运行能够安全定位的相关测试；不会擅自运行整个仓库测试套件。",
			"用户明确要求完整测试时使用 operation=test 并把 path 指向项目目录；只检查类型或规范时使用 typecheck 或 lint。",
			"verify 能处理的 TypeScript/JavaScript、Python 和 Go 检查不得改用 bash、python、node 或 go 命令。除非用户明确要求运行程序，否则不得通过终端执行普通源文件。",
			"不要通过 bash 重复运行 verify 已经执行的命令，也不要为了判断项目类型先调用环境变量或目录枚举命令。",
			"verify 失败后根据关键输出修复；同一问题最多再验证一次，仍失败就报告，不要循环重试。",
			"工具缺失、超时或无法识别项目时立即说明并继续任务，不要自动安装依赖。",
		],
		parameters: VerifyParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const operation = params.operation ?? "auto";
			const service = await loadService();
			const result = await service.verify(
				{
					operation,
					...(params.path === undefined ? {} : { path: params.path }),
					...(params.timeout === undefined ? {} : { timeoutSeconds: params.timeout }),
				},
				ctx.cwd,
				signal,
				(message) =>
					onUpdate?.({
						content: [{ type: "text", text: message }],
						details: {
							operation,
							language: "typescript",
							workspaceRoot: ctx.cwd,
							passed: false,
							checks: [],
							truncated: false,
							durationMs: 0,
						},
					}),
			);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});
}

export function createVerifyExtension(service: VerifyToolService): (pi: ExtensionAPI) => void {
	return (pi) => registerVerifyExtension(pi, async () => service);
}

export default function verifyExtension(pi: ExtensionAPI): void {
	let servicePromise: Promise<VerifyToolService> | undefined;
	registerVerifyExtension(pi, () => {
		servicePromise ??= import("./service.ts").then(({ VerifyService }) => new VerifyService());
		return servicePromise;
	});
}
