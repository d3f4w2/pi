import type { ToolInfo } from "../../core/extensions/types.ts";

export const TOOL_DISCOVERY_BUDGET = 2;
export const TOOL_SEARCH_NAME = "tool_search";
const MIN_DISCOVERY_SCORE = 30;
const RELATIVE_SCORE_THRESHOLD = 0.5;

const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
	read: "读取文件内容",
	bash: "运行终端命令",
	edit: "修改文件内容",
	write: "新建或覆盖文件",
	grep: "搜索文件里的文字",
	ast_grep: "按代码结构精确搜索",
	code_search: "按意思快速找到相关代码",
	lsp: "准确查询代码关系和错误",
	todo: "维护任务计划和进度",
	verify: "运行相关检查和测试",
	find: "按名称查找文件",
	ls: "查看文件夹内容",
	web_search: "搜索互联网并返回来源",
	web_fetch: "读取并整理网页内容",
	tool_search: "按需要查找并加载工具",
	git: "安全查看、暂存、提交和推送代码",
	process: "启动后台服务并增量查看日志",
	browser: "打开网页并验证真实交互和截图",
	memory: "保存、找回或忘记可靠记忆",
};

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string): Set<string> {
	const tokens = new Set<string>();
	for (const segment of normalizeText(value).match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? []) {
		if (/^[a-z0-9]+$/.test(segment)) {
			if (segment.length > 1) tokens.add(segment);
			continue;
		}
		if (segment.length === 1) {
			tokens.add(segment);
			continue;
		}
		for (let index = 0; index < segment.length - 1; index++) {
			tokens.add(segment.slice(index, index + 2));
		}
	}
	return tokens;
}

function overlapCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	let count = 0;
	for (const token of left) {
		if (right.has(token)) count++;
	}
	return count;
}

function scoreTool(query: string, queryTokens: ReadonlySet<string>, tool: ToolInfo): number {
	const name = normalizeText(tool.name);
	let score = 0;
	if (query === name) score += 1000;
	else if (query.includes(name) || name.includes(query)) score += 400;
	score += overlapCount(queryTokens, tokenize(name)) * 80;

	for (const rawKeyword of tool.discovery?.keywords ?? []) {
		const keyword = normalizeText(rawKeyword);
		if (!keyword) continue;
		if (query === keyword) score += 300;
		else if (query.includes(keyword)) score += 180;
		else if (keyword.includes(query)) score += 120;
		score += overlapCount(queryTokens, tokenize(keyword)) * 30;
	}

	const supportingText = [tool.description, ...(tool.promptGuidelines ?? [])].join(" ");
	score += overlapCount(queryTokens, tokenize(supportingText)) * 5;
	return score;
}

export function rankDiscoverableTools(
	query: string,
	tools: readonly ToolInfo[],
	enabledToolNames: ReadonlySet<string>,
	limit = TOOL_DISCOVERY_BUDGET,
): ToolInfo[] {
	const normalizedQuery = normalizeText(query);
	if (!normalizedQuery || limit <= 0) return [];
	const queryTokens = tokenize(normalizedQuery);
	const ranked = tools
		.map((tool, index) => ({ tool, index, score: scoreTool(normalizedQuery, queryTokens, tool) }))
		.filter(
			({ tool, score }) =>
				tool.discovery !== undefined && enabledToolNames.has(tool.name) && score >= MIN_DISCOVERY_SCORE,
		)
		.sort((left, right) => right.score - left.score || left.index - right.index);
	const bestScore = ranked[0]?.score;
	if (bestScore === undefined) return [];
	const relevantScore = Math.max(MIN_DISCOVERY_SCORE, bestScore * RELATIVE_SCORE_THRESHOLD);
	const relevant = ranked.filter(({ score }) => score >= relevantScore);
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const selected: ToolInfo[] = [];
	const selectedNames = new Set<string>();
	const addTool = (tool: ToolInfo | undefined): void => {
		if (
			!tool ||
			selected.length >= limit ||
			selectedNames.has(tool.name) ||
			tool.discovery === undefined ||
			!enabledToolNames.has(tool.name)
		) {
			return;
		}
		selected.push(tool);
		selectedNames.add(tool.name);
	};
	for (const { tool } of relevant) {
		addTool(tool);
		for (const companionName of tool.discovery?.companionTools ?? []) addTool(toolsByName.get(companionName));
		if (selected.length >= limit) break;
	}
	return selected;
}

export function deriveActiveToolNames(
	tools: readonly ToolInfo[],
	enabledToolNames: ReadonlySet<string>,
	discoveredToolNames: ReadonlySet<string>,
): string[] {
	const discoveryEnabled = enabledToolNames.has(TOOL_SEARCH_NAME);
	return tools.flatMap((tool) => {
		if (!enabledToolNames.has(tool.name)) return [];
		if (!discoveryEnabled || tool.discovery === undefined || discoveredToolNames.has(tool.name)) return [tool.name];
		return [];
	});
}

export function getToolDescription(toolName: string): string {
	return TOOL_DESCRIPTIONS[toolName] ?? "扩展提供的工具";
}
