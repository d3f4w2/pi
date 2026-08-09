import { Container, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "../../core/extensions/types.ts";
import { renderFileDiff } from "../../modes/interactive/components/diff.ts";
import { GitService } from "./service.ts";
import type { GitDiffScope, GitToolDetails } from "./types.ts";
import { type GitDashboardResult, showGitDashboard, showGitDiff } from "./ui.ts";

const GitPath = Type.String({ minLength: 1, maxLength: 4096, description: "仓库中的相对文件路径" });
const GitPaths = Type.Array(GitPath, { minItems: 1, maxItems: 100, description: "明确指定的文件路径" });
const GitParams = Type.Union([
	Type.Object(
		{ operation: Type.Literal("overview"), max_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("diff"),
			path: GitPath,
			scope: Type.Optional(
				Type.Union([Type.Literal("all"), Type.Literal("staged"), Type.Literal("worktree")], {
					description: "all=相对 HEAD，staged=暂存区，worktree=未暂存内容",
				}),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("log"), max_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) },
		{ additionalProperties: false },
	),
	Type.Object({ operation: Type.Literal("stage"), paths: GitPaths }, { additionalProperties: false }),
	Type.Object({ operation: Type.Literal("unstage"), paths: GitPaths }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("commit"),
			message: Type.String({ minLength: 1, maxLength: 500, description: "简短、准确的提交信息" }),
			paths: GitPaths,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("push"),
			remote: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
			branch: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
			set_upstream: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
]);

type GitParams = Static<typeof GitParams>;
type GitServiceLike = Pick<GitService, "overview" | "diff" | "log" | "stage" | "unstage" | "commit" | "push">;

function operationOf(args: unknown): string {
	return typeof args === "object" && args !== null && typeof Reflect.get(args, "operation") === "string"
		? String(Reflect.get(args, "operation"))
		: "unknown";
}

function gitApproval(args: unknown) {
	const operation = operationOf(args);
	if (operation === "overview" || operation === "diff" || operation === "log") return "read" as const;
	if (operation === "stage" || operation === "unstage") return { tier: "write" as const, reason: "修改 Git 暂存区" };
	if (operation === "commit") return { tier: "exec" as const, reason: "创建 Git 提交并可能运行提交钩子" };
	if (operation === "push") {
		return { tier: "exec" as const, policy: "prompt" as const, override: true, reason: "向远程仓库推送提交" };
	}
	return { tier: "exec" as const, policy: "prompt" as const, override: true, reason: "未知 Git 操作" };
}

function approvalDetails(args: unknown): string[] {
	if (typeof args !== "object" || args === null) return [];
	const operation = operationOf(args);
	const paths = Reflect.get(args, "paths");
	const message = Reflect.get(args, "message");
	return [
		`操作：${operation}`,
		...(Array.isArray(paths)
			? [`文件：${paths.filter((item): item is string => typeof item === "string").join("、")}`]
			: []),
		...(typeof message === "string" ? [`提交信息：${message}`] : []),
	];
}

async function executeGit(service: GitServiceLike, params: GitParams, cwd: string, signal?: AbortSignal) {
	switch (params.operation) {
		case "overview": {
			const result = await service.overview(cwd, signal, params.max_files);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { operation: "overview" as const, overview: result.overview },
			};
		}
		case "diff": {
			const scope: GitDiffScope = params.scope ?? "all";
			const result = await service.diff(cwd, params.path, scope, signal);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { operation: "diff" as const, scope, file: result.file, diff: result.diff },
			};
		}
		case "log": {
			const result = await service.log(cwd, signal, params.max_count);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { operation: "log" as const, entries: result.entries },
			};
		}
		case "stage": {
			const result = await service.stage(cwd, params.paths, signal);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { operation: "stage" as const, paths: result.paths, overview: result.overview },
			};
		}
		case "unstage": {
			const result = await service.unstage(cwd, params.paths, signal);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { operation: "unstage" as const, paths: result.paths, overview: result.overview },
			};
		}
		case "commit": {
			const result = await service.commit(cwd, params.message, params.paths, signal);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { operation: "commit" as const, hash: result.hash, paths: result.paths },
			};
		}
		case "push": {
			const result = await service.push(
				cwd,
				{
					...(params.remote === undefined ? {} : { remote: params.remote }),
					...(params.branch === undefined ? {} : { branch: params.branch }),
					...(params.set_upstream === undefined ? {} : { setUpstream: params.set_upstream }),
				},
				signal,
			);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: { operation: "push" as const, output: result.output },
			};
		}
	}
}

async function manageGit(service: GitServiceLike, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const operation = await ctx.ui.select("Git", ["管理变更", "提交暂存内容", "推送", "查看历史", "关闭"]);
		if (operation === undefined || operation === "关闭") return;
		if (operation === "查看历史") {
			try {
				ctx.ui.notify((await service.log(ctx.cwd, ctx.signal, 20)).text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			continue;
		}
		if (operation === "管理变更") {
			try {
				const initial = await service.overview(ctx.cwd, ctx.signal, 1000);
				const result = await ctx.ui.custom<GitDashboardResult>((tui, theme, keybindings, done) =>
					showGitDashboard(
						initial.overview,
						tui,
						theme,
						keybindings,
						async (file, staged) =>
							staged
								? (await service.stage(ctx.cwd, [file.path], ctx.signal)).overview
								: (await service.unstage(ctx.cwd, [file.path], ctx.signal)).overview,
						(message) => ctx.ui.notify(message, "error"),
						done,
					),
				);
				if (result.type === "diff") {
					const diff = await service.diff(ctx.cwd, result.path, "all", ctx.signal);
					await ctx.ui.custom<void>((_tui, _theme, keybindings, done) =>
						showGitDiff(diff.diff, keybindings, done),
					);
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			continue;
		}
		if (operation === "提交暂存内容") {
			try {
				const overview = (await service.overview(ctx.cwd, ctx.signal, 1000)).overview;
				const paths = overview.files.filter((file) => file.staged).map((file) => file.path);
				if (paths.length === 0) {
					ctx.ui.notify("暂存区没有可提交的文件。", "warning");
					continue;
				}
				const message = await ctx.ui.input("提交信息", "例如：feat(coding-agent): 增加 Git 工具");
				if (!message?.trim()) continue;
				const confirmed = await ctx.ui.confirm("确认提交", `${message.trim()}\n\n文件：\n${paths.join("\n")}`);
				if (!confirmed) continue;
				ctx.ui.notify((await service.commit(ctx.cwd, message, paths, ctx.signal)).text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			continue;
		}
		if (operation === "推送") {
			const confirmed = await ctx.ui.confirm("确认推送", "将当前分支推送到已配置的上游远程仓库。是否继续？");
			if (!confirmed) continue;
			try {
				ctx.ui.notify((await service.push(ctx.cwd, {}, ctx.signal)).text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		}
	}
}

function registerGitExtension(pi: ExtensionAPI, service: GitServiceLike): void {
	const definition: ToolDefinition<typeof GitParams, GitToolDetails> = {
		name: "git",
		label: "Git 版本管理",
		description: "查看变更和历史，精确暂存、取消暂存、提交或推送。",
		discovery: {
			keywords: ["git", "提交代码", "查看改动", "暂存文件", "推送代码", "commit", "diff", "push"],
			companionTools: ["verify"],
		},
		promptSnippet: "用紧凑、安全的结构化操作管理 Git 变更、提交和推送",
		promptGuidelines: [
			"查看或操作 Git 时优先使用 git 工具，不要用 bash、PowerShell 或 WSL 执行同类 Git 命令。",
			"先 overview，再按具体 path 查看 diff；不要一次读取所有大型 Diff。",
			"stage、unstage 和 commit 必须使用明确文件列表，不要猜测或扩大范围。",
			"只有用户明确要求提交时才 commit，只有用户明确要求推送时才 push。",
			"git 工具失败时说明错误；不要改用带有 add .、reset --hard 或 force push 的终端命令。",
		],
		parameters: GitParams,
		executionMode: "sequential",
		approval: gitApproval,
		formatApprovalDetails: approvalDetails,
		renderCall(params, theme) {
			const target = "path" in params ? ` ${params.path}` : "paths" in params ? ` ${params.paths.join("、")}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("git"))} ${params.operation}${target}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const component = new Container();
			if (result.details?.operation === "diff") {
				component.addChild(new Text(renderFileDiff(result.details.diff, { expanded: true }), 0, 0));
				return component;
			}
			const text = result.content.find((item) => item.type === "text")?.text;
			if (text) component.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
			return component;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeGit(service, params, ctx.cwd, signal);
		},
	};
	pi.registerTool(definition);
	pi.registerCommand("git", {
		description: "查看、暂存、提交或推送 Git 变更",
		handler: async (_args, ctx) => manageGit(service, ctx),
	});
}

export function createGitExtension(service: GitServiceLike): (pi: ExtensionAPI) => void {
	return (pi) => registerGitExtension(pi, service);
}

export default function gitExtension(pi: ExtensionAPI): void {
	registerGitExtension(pi, new GitService());
}
