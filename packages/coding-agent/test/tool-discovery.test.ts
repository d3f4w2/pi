import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import {
	deriveActiveToolNames,
	rankDiscoverableTools,
	TOOL_DISCOVERY_BUDGET,
} from "../src/extensions/tools/discovery.ts";

function tool(name: string, keywords?: string[], companionTools?: string[]): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: Type.Object({}),
		...(keywords ? { discovery: { keywords, ...(companionTools === undefined ? {} : { companionTools }) } } : {}),
		sourceInfo: {
			path: `<test:${name}>`,
			baseDir: ".",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		},
	};
}

const tools = [
	tool("read"),
	tool("tool_search"),
	tool("ast_grep", ["代码结构", "语法结构", "structural code search"]),
	tool("code_search", ["代码意图", "语义搜索", "semantic code search"]),
	tool("verify", ["检查修改", "类型检查", "运行测试", "verify code"]),
	tool("web_search", ["网页", "联网搜索", "最新资料", "最新版本", "web search"], ["web_fetch"]),
	tool("web_fetch", ["网页", "读取网址", "网页正文", "fetch webpage"]),
];

describe("tool discovery", () => {
	test("finds tools from Chinese intent and keeps results within budget", () => {
		const results = rankDiscoverableTools("帮我查一下网页资料", tools, new Set(tools.map((item) => item.name)));

		expect(results.map((item) => item.name)).toEqual(["web_search", "web_fetch"]);
		expect(results).toHaveLength(TOOL_DISCOVERY_BUDGET);
	});

	test("loads the web companion without filling the budget with a weak code match", () => {
		const results = rankDiscoverableTools(
			"帮我搜索一下 Pi 最新版本的信息",
			tools,
			new Set(tools.map((item) => item.name)),
		);

		expect(results.map((item) => item.name)).toEqual(["web_search", "web_fetch"]);
	});

	test("does not fill unused budget with weakly related tools", () => {
		const results = rankDiscoverableTools("检查代码结构", tools, new Set(tools.map((item) => item.name)));

		expect(results.map((item) => item.name)).toEqual(["ast_grep"]);
	});

	test("supports English intent and exact tool names", () => {
		const enabled = new Set(tools.map((item) => item.name));

		expect(rankDiscoverableTools("verify code", tools, enabled)[0]?.name).toBe("verify");
		expect(rankDiscoverableTools("code_search", tools, enabled)[0]?.name).toBe("code_search");
	});

	test("never returns tools disabled by the user", () => {
		const enabled = new Set(tools.map((item) => item.name));
		enabled.delete("web_fetch");

		expect(rankDiscoverableTools("网页", tools, enabled).map((item) => item.name)).toEqual(["web_search"]);
	});

	test("returns no result for unrelated intent", () => {
		const enabled = new Set(tools.map((item) => item.name));

		expect(rankDiscoverableTools("播放一首音乐", tools, enabled)).toEqual([]);
	});

	test("exposes eager tools plus the latest discovered tools", () => {
		const enabled = new Set(tools.map((item) => item.name));
		const active = deriveActiveToolNames(tools, enabled, new Set(["web_search", "web_fetch"]));

		expect(active).toEqual(["read", "tool_search", "web_search", "web_fetch"]);
	});

	test("restores all enabled tools when tool_search is disabled", () => {
		const enabled = new Set(tools.map((item) => item.name));
		enabled.delete("tool_search");

		expect(deriveActiveToolNames(tools, enabled, new Set())).toEqual([
			"read",
			"ast_grep",
			"code_search",
			"verify",
			"web_search",
			"web_fetch",
		]);
	});
});
