import type { InlineExtension } from "../core/extensions/types.ts";
import apiExtension from "./api/index.ts";
import astGrepExtension from "./ast-grep/index.ts";
import browserExtension from "./browser/index.ts";
import codeSearchExtension from "./code-search/index.ts";
import debugExtension from "./debug/index.ts";
import doctorExtension from "./doctor/index.ts";
import evalExtension from "./eval/index.ts";
import evalsExtension from "./evals/index.ts";
import executionControllerExtension from "./execution-controller/index.ts";
import gitExtension from "./git/index.ts";
import llamaExtension from "./llama/index.ts";
import lspExtension from "./lsp/index.ts";
import processExtension from "./process/index.ts";
import runMetricsExtension from "./run-metrics/index.ts";
import taskLedgerExtension from "./task-ledger/index.ts";
import toolsExtension from "./tools/index.ts";
import turnUndoExtension from "./turn-undo/index.ts";
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
	{ name: "单代理执行闭环", factory: executionControllerExtension, hidden: true },
	{ name: "执行效果统计", factory: runMetricsExtension, hidden: true },
	{ name: "持久代码运行", factory: evalExtension, hidden: true },
	{ name: "本地评测", factory: evalsExtension, hidden: true },
	{ name: "DAP 调试器", factory: debugExtension, hidden: true },
	{ name: "后台进程管理", factory: processExtension, hidden: true },
	{ name: "隔离浏览器", factory: browserExtension, hidden: true },
	{ name: "Git 版本管理", factory: gitExtension, hidden: true },
	{ name: "任务计划", factory: taskLedgerExtension, hidden: true },
	{ name: "回合文件撤销", factory: turnUndoExtension, hidden: true },
	{ name: "联网工具", factory: webExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
