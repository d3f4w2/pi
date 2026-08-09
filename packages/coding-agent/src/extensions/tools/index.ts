import { Type } from "typebox";
import { isBunBinary } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { ToolApprovalSetting } from "../../core/settings-manager.ts";
import {
	deriveActiveToolNames,
	getToolDescription,
	rankDiscoverableTools,
	TOOL_DISCOVERY_BUDGET,
	TOOL_SEARCH_NAME,
} from "./discovery.ts";
import { showPermissionsManager } from "./permissions-ui.ts";
import { applyToolPreferences, ToolPreferencesStorage, type ToolPreferencesStore } from "./storage.ts";
import { showToolsManager } from "./ui.ts";

const ToolSearchParams = Type.Object(
	{
		query: Type.String({
			minLength: 2,
			maxLength: 100,
			description: "用简短中文或英文说明需要什么能力，例如“读取网页”或“检查代码结构”",
		}),
	},
	{ additionalProperties: false },
);

interface ToolSearchDetails {
	query: string;
	loadedTools: string[];
	activeTools: string[];
}

interface ToolsRuntimeState {
	enabledToolNames: Set<string> | undefined;
	discoveredToolNames: Set<string>;
	knownToolNames: Set<string>;
}

function getEnabledToolNames(pi: ExtensionAPI, state: ToolsRuntimeState): Set<string> {
	state.enabledToolNames ??= new Set(pi.getActiveTools());
	const activeToolNames = new Set(pi.getActiveTools());
	for (const tool of pi.getAllTools()) {
		if (state.knownToolNames.has(tool.name)) continue;
		state.knownToolNames.add(tool.name);
		if (activeToolNames.has(tool.name)) state.enabledToolNames.add(tool.name);
	}
	return state.enabledToolNames;
}

function applyRuntimeTools(pi: ExtensionAPI, state: ToolsRuntimeState): void {
	const next = deriveActiveToolNames(pi.getAllTools(), getEnabledToolNames(pi, state), state.discoveredToolNames);
	const current = pi.getActiveTools();
	if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
		pi.setActiveTools(next);
	}
}

function replaceDiscoveredTools(state: ToolsRuntimeState, toolNames: readonly string[]): void {
	state.discoveredToolNames.clear();
	for (const toolName of toolNames) state.discoveredToolNames.add(toolName);
}

async function manageTools(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	preferences: ToolPreferencesStore,
	state: ToolsRuntimeState,
): Promise<void> {
	const tools = pi.getAllTools();
	if (tools.length === 0) {
		ctx.ui.notify("当前没有可用工具。", "warning");
		return;
	}
	const enabledToolNames = getEnabledToolNames(pi, state);
	const initialEnabledTools = new Set(enabledToolNames);
	let codeSearchActivationRequested = false;
	let browserActivationRequested = false;
	let lspActivationRequested = false;
	let processActivationRequested = false;
	let toolSearchActivationRequested = false;
	let verifyActivationRequested = false;

	await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
		showToolsManager(
			tui,
			theme,
			keybindings,
			tools,
			[...enabledToolNames],
			(toolName, active) => {
				if (toolName === "browser" && active) browserActivationRequested = true;
				if (toolName === "code_search" && active) codeSearchActivationRequested = true;
				if (toolName === "lsp" && active) lspActivationRequested = true;
				if (toolName === TOOL_SEARCH_NAME && active) toolSearchActivationRequested = true;
				if (toolName === "process" && active) processActivationRequested = true;
				if (toolName === "verify" && active) verifyActivationRequested = true;
				if (enabledToolNames.has(toolName) === active) return;
				if (active) enabledToolNames.add(toolName);
				else enabledToolNames.delete(toolName);
				if (toolName === TOOL_SEARCH_NAME || !active) state.discoveredToolNames.clear();
				applyRuntimeTools(pi, state);
			},
			done,
		),
	);

	const finalEnabledTools = getEnabledToolNames(pi, state);
	const changes = tools.flatMap((tool) => {
		const wasEnabled = initialEnabledTools.has(tool.name);
		const isEnabled = finalEnabledTools.has(tool.name);
		return wasEnabled === isEnabled ? [] : [{ toolName: tool.name, active: isEnabled }];
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

	if (codeSearchActivationRequested && finalEnabledTools.has("code_search")) {
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
	if (lspActivationRequested && finalEnabledTools.has("lsp")) {
		ctx.ui.notify(
			[
				isBunBinary
					? "lsp 已开启。独立二进制需要先安装：npm install -g typescript-language-server typescript"
					: "lsp 已开启。TypeScript/JavaScript 可以直接使用，第一次调用通常需要几秒。",
				"Python：pip install basedpyright",
				"Go：go install golang.org/x/tools/gopls@latest",
				"修改代码后会批量检查相关文件；没有错误时不会占用模型上下文。",
				"服务器不可用时会立即改用 grep 和 read，不会阻塞任务。",
			].join("\n"),
			"info",
		);
	}
	if (toolSearchActivationRequested && finalEnabledTools.has(TOOL_SEARCH_NAME)) {
		ctx.ui.notify(
			`tool_search 已开启。低频工具会按需加载，每次最多 ${TOOL_DISCOVERY_BUDGET} 个；搜索失败不会阻塞任务。`,
			"info",
		);
	}
	if (verifyActivationRequested && finalEnabledTools.has("verify")) {
		ctx.ui.notify(
			[
				"verify 已开启。TypeScript/JavaScript 会使用项目脚本或本地 TypeScript；Go 使用 go test/go vet。",
				"Python 类型检查：pip install basedpyright",
				"Python 测试和规范检查按需使用 pytest、ruff；缺少时只提示，不会自动安装。",
				"默认只检查相关范围，不会擅自运行整个仓库测试。",
			].join("\n"),
			"info",
		);
	}
	if (processActivationRequested && finalEnabledTools.has("process")) {
		ctx.ui.notify(
			[
				"process 已开启。可以在后台启动开发服务器、监听器和测试观察模式。",
				"日志按游标增量读取，不会反复占用模型上下文。",
				"只管理 Pi 当前会话启动的进程；退出 Pi 时会自动停止。",
			].join("\n"),
			"info",
		);
	}
	if (browserActivationRequested && finalEnabledTools.has("browser")) {
		ctx.ui.notify(
			[
				"browser 已开启。会自动使用本机 Chrome、Edge 或 Chromium，不需要额外安装插件。",
				"浏览器使用临时隔离配置，不读取个人 Cookie、登录状态或扩展。",
				"找不到浏览器时，请设置 PI_BROWSER_EXECUTABLE 为浏览器程序路径。",
			].join("\n"),
			"info",
		);
	}
}

async function managePermissions(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const tools = pi.getAllTools();
	if (tools.length === 0) {
		ctx.ui.notify("当前没有可用工具。", "warning");
		return;
	}
	const settings = ctx.getToolApprovalSettings?.();
	if (!settings || !ctx.setToolApprovalPolicy) {
		ctx.ui.notify("当前运行环境不支持权限管理。", "warning");
		return;
	}

	const result = await ctx.ui.custom<Readonly<Record<string, ToolApprovalSetting>> | undefined>(
		(tui, theme, keybindings, done) =>
			showPermissionsManager(tui, theme, keybindings, tools, settings.mode, settings.policies, done),
	);
	if (result === undefined) return;

	try {
		for (const tool of tools) {
			const name = tool.name.toLowerCase();
			const current = settings.policies[name];
			const next = result[name];
			if (current !== next) ctx.setToolApprovalPolicy(tool.name, next);
		}
	} catch (error) {
		ctx.ui.notify(`权限保存失败：${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

function registerToolsExtension(pi: ExtensionAPI, preferences: ToolPreferencesStore): void {
	const state: ToolsRuntimeState = {
		enabledToolNames: undefined,
		discoveredToolNames: new Set(),
		knownToolNames: new Set(),
	};

	pi.registerTool<typeof ToolSearchParams, ToolSearchDetails>({
		name: TOOL_SEARCH_NAME,
		label: "查找工具",
		description: "需要的低频工具当前没有显示时，按能力查找并临时加载；只加载，不执行。",
		promptSnippet: "查找并加载当前没有显示的低频工具",
		promptGuidelines: [
			"当前工具已经能完成任务时不要调用 tool_search。",
			"缺少能力时，用具体动作描述查询，例如“读取网页”或“检查代码结构”，不要只输入宽泛词语。",
			"tool_search 只加载工具；成功后下一轮直接调用目标工具，不要重复搜索。",
			"没有匹配结果时继续使用现有工具或简短说明限制，不要循环重试。",
		],
		parameters: ToolSearchParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const enabledToolNames = getEnabledToolNames(pi, state);
			const matches = rankDiscoverableTools(params.query, pi.getAllTools(), enabledToolNames);
			if (matches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "没有找到匹配的已开启工具。请换成更具体的能力描述，或继续使用现有工具。",
						},
					],
					details: { query: params.query, loadedTools: [], activeTools: pi.getActiveTools() },
				};
			}

			replaceDiscoveredTools(
				state,
				matches.map((tool) => tool.name),
			);
			applyRuntimeTools(pi, state);
			const loaded = matches.map((tool) => `${tool.name}（${getToolDescription(tool.name)}）`).join("、");
			return {
				content: [{ type: "text", text: `已加载：${loaded}。下一步直接使用合适的工具。` }],
				details: {
					query: params.query,
					loadedTools: matches.map((tool) => tool.name),
					activeTools: pi.getActiveTools(),
				},
			};
		},
	});

	pi.on("session_start", async () => {
		const current = pi.getActiveTools();
		const available = pi.getAllTools().map((tool) => tool.name);
		try {
			const saved = await preferences.load();
			state.enabledToolNames = new Set(applyToolPreferences(current, available, saved));
		} catch {
			// Tool preferences are optional and must never block session startup.
			state.enabledToolNames = new Set(current);
		}
		state.knownToolNames = new Set(available);
		state.discoveredToolNames.clear();
		applyRuntimeTools(pi, state);
	});

	pi.on("before_agent_start", () => {
		applyRuntimeTools(pi, state);
	});

	pi.registerCommand("permissions", {
		description: "查看或修改工具执行权限",
		handler: async (_args, ctx) => managePermissions(pi, ctx),
	});

	pi.registerCommand("tools", {
		description: "查看、开启或关闭工具",
		handler: async (_args, ctx) => manageTools(pi, ctx, preferences, state),
	});
}

export function createToolsExtension(preferences: ToolPreferencesStore): (pi: ExtensionAPI) => void {
	return (pi) => registerToolsExtension(pi, preferences);
}

export default function toolsExtension(pi: ExtensionAPI): void {
	registerToolsExtension(pi, new ToolPreferencesStorage());
}
