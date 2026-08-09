import type { InlineExtension } from "../core/extensions/types.ts";
import apiExtension from "./api/index.ts";
import astGrepExtension from "./ast-grep/index.ts";
import codeSearchExtension from "./code-search/index.ts";
import doctorExtension from "./doctor/index.ts";
import llamaExtension from "./llama/index.ts";
import lspExtension from "./lsp/index.ts";
import taskLedgerExtension from "./task-ledger/index.ts";
import toolsExtension from "./tools/index.ts";
import verifyExtension from "./verify/index.ts";
import webExtension from "./web/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "API 供应商管理", factory: apiExtension, hidden: true },
	{ name: "工具管理", factory: toolsExtension, hidden: true },
	{ name: "运行环境诊断", factory: doctorExtension, hidden: true },
	{ name: "代码结构搜索", factory: astGrepExtension, hidden: true },
	{ name: "语义代码搜索", factory: codeSearchExtension, hidden: true },
	{ name: "LSP 代码理解", factory: lspExtension, hidden: true },
	{ name: "代码验证", factory: verifyExtension, hidden: true },
	{ name: "任务计划", factory: taskLedgerExtension, hidden: true },
	{ name: "联网工具", factory: webExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
