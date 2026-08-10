import type { InlineExtension } from "../core/extensions/types.ts";
import contextLifecycleExtension from "./context/index.ts";
import taskWorkerExtension from "./task/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "Controlled plugins", load: async () => (await import("./plugins/index.ts")).default, hidden: true },
	{ name: "API 供应商管理", load: async () => (await import("./api/index.ts")).default, hidden: true },
	{ name: "工具管理", load: async () => (await import("./tools/index.ts")).default, hidden: true },
	{ name: "运行环境诊断", load: async () => (await import("./doctor/index.ts")).default, hidden: true },
	{ name: "AST 结构化搜索", load: async () => (await import("./ast-grep/index.ts")).default, hidden: true },
	{ name: "语义代码搜索", load: async () => (await import("./code-search/index.ts")).default, hidden: true },
	{ name: "LSP 代码智能", load: async () => (await import("./lsp/index.ts")).default, hidden: true },
	{ name: "Git 工作流", load: async () => (await import("./git/index.ts")).default, hidden: true },
	{ name: "执行治理", load: async () => (await import("./execution-controller/index.ts")).default, hidden: true },
	{ name: "结果验证", load: async () => (await import("./verify/index.ts")).default, hidden: true },
	{ name: "执行效果统计", load: async () => (await import("./run-metrics/index.ts")).default, hidden: true },
	{ name: "上下文生命周期", factory: contextLifecycleExtension, hidden: true },
	{ name: "持久代码运行", load: async () => (await import("./eval/index.ts")).default, hidden: true },
	{ name: "本地评测", load: async () => (await import("./evals/index.ts")).default, hidden: true },
	{ name: "证据型记忆", load: async () => (await import("./memory/index.ts")).default, hidden: true },
	{ name: "受控自进化", load: async () => (await import("./learning/index.ts")).default, hidden: true },
	{ name: "DAP 调试器", load: async () => (await import("./debug/index.ts")).default, hidden: true },
	{ name: "后台进程管理", load: async () => (await import("./process/index.ts")).default, hidden: true },
	{ name: "隔离浏览器", load: async () => (await import("./browser/index.ts")).default, hidden: true },
	{ name: "回合撤销", load: async () => (await import("./turn-undo/index.ts")).default, hidden: true },
	{ name: "任务计划", load: async () => (await import("./task-ledger/index.ts")).default, hidden: true },
	{ name: "联网工具", load: async () => (await import("./web/index.ts")).default, hidden: true },
	{ name: "MCP 服务器", load: async () => (await import("./mcp/index.ts")).default, hidden: true },
	{ name: "llama.cpp", load: async () => (await import("./llama/index.ts")).default, hidden: true },
	{ name: "隔离任务 worker", factory: taskWorkerExtension, hidden: true },
];
