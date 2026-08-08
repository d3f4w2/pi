import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { showToolsManager } from "./ui.ts";

async function manageTools(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const tools = pi.getAllTools();
	if (tools.length === 0) {
		ctx.ui.notify("当前没有可用工具。", "warning");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
		showToolsManager(
			tui,
			theme,
			keybindings,
			tools,
			pi.getActiveTools(),
			(toolName, active) => {
				const currentTools = pi.getActiveTools();
				pi.setActiveTools(active ? [...currentTools, toolName] : currentTools.filter((name) => name !== toolName));
			},
			done,
		),
	);
}

export default function toolsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tools", {
		description: "查看、开启或关闭工具",
		handler: async (_args, ctx) => manageTools(pi, ctx),
	});
}
