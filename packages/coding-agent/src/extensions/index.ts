import type { InlineExtension } from "../core/extensions/types.ts";
import apiExtension from "./api/index.ts";
import codeSearchExtension from "./code-search/index.ts";
import llamaExtension from "./llama/index.ts";
import toolsExtension from "./tools/index.ts";
import webExtension from "./web/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "API 供应商管理", factory: apiExtension, hidden: true },
	{ name: "工具管理", factory: toolsExtension, hidden: true },
	{ name: "语义代码搜索", factory: codeSearchExtension, hidden: true },
	{ name: "联网工具", factory: webExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
