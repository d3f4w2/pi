import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { applyToolPreferences, ToolPreferencesStorage, type ToolPreferencesStore } from "./storage.ts";
import { showToolsManager } from "./ui.ts";

async function manageTools(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	preferences: ToolPreferencesStore,
): Promise<void> {
	const tools = pi.getAllTools();
	if (tools.length === 0) {
		ctx.ui.notify("当前没有可用工具。", "warning");
		return;
	}
	const initialActiveTools = new Set(pi.getActiveTools());
	let codeSearchActivationRequested = false;

	await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
		showToolsManager(
			tui,
			theme,
			keybindings,
			tools,
			pi.getActiveTools(),
			(toolName, active) => {
				if (toolName === "code_search" && active) codeSearchActivationRequested = true;
				const currentTools = pi.getActiveTools();
				if (currentTools.includes(toolName) === active) return;
				pi.setActiveTools(active ? [...currentTools, toolName] : currentTools.filter((name) => name !== toolName));
			},
			done,
		),
	);

	const finalActiveTools = new Set(pi.getActiveTools());
	const changes = tools.flatMap((tool) => {
		const wasActive = initialActiveTools.has(tool.name);
		const isActive = finalActiveTools.has(tool.name);
		return wasActive === isActive ? [] : [{ toolName: tool.name, active: isActive }];
	});
	if (changes.length > 0) {
		try {
			await preferences.recordChanges(changes);
		} catch (error) {
			ctx.ui.notify(
				`工具已在当前会话更新，但保存失败：${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	if (codeSearchActivationRequested && pi.getActiveTools().includes("code_search")) {
		ctx.ui.notify(
			[
				"code_search 已开启。首次使用请在 PowerShell 安装并登录 mgrep：",
				"npm install -g @mixedbread/mgrep",
				"mgrep login（约 1–2 分钟）",
				"代码会同步到 Mixedbread；请用 .gitignore 或 .mgrepignore 排除敏感文件。",
				"默认最多同步 5000 个文件；超大项目会改用较小范围。",
				"首次使用会在后台建立索引，不会阻塞当前任务；未就绪时自动改用其他搜索方式。",
			].join("\n"),
			"info",
		);
	}
}

function registerToolsExtension(pi: ExtensionAPI, preferences: ToolPreferencesStore): void {
	pi.on("session_start", async () => {
		try {
			const saved = await preferences.load();
			const current = pi.getActiveTools();
			const next = applyToolPreferences(
				current,
				pi.getAllTools().map((tool) => tool.name),
				saved,
			);
			if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
				pi.setActiveTools(next);
			}
		} catch {
			// Tool preferences are optional and must never block session startup.
		}
	});

	pi.registerCommand("tools", {
		description: "查看、开启或关闭工具",
		handler: async (_args, ctx) => manageTools(pi, ctx, preferences),
	});
}

export function createToolsExtension(preferences: ToolPreferencesStore): (pi: ExtensionAPI) => void {
	return (pi) => registerToolsExtension(pi, preferences);
}

export default function toolsExtension(pi: ExtensionAPI): void {
	registerToolsExtension(pi, new ToolPreferencesStorage());
}
