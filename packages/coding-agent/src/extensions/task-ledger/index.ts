import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	formatTaskLedger,
	formatTaskLedgerContext,
	formatTaskLedgerWidget,
	loadLatestTaskLedgerState,
	reduceTaskLedger,
} from "./state.ts";
import {
	MAX_TASK_NOTE_LENGTH,
	MAX_TASK_PHASES,
	MAX_TASK_TITLE_LENGTH,
	MAX_TASKS,
	TASK_LEDGER_ENTRY_TYPE,
	type TaskLedgerAction,
	type TaskLedgerState,
} from "./types.ts";

const ExpectedRevision = Type.Integer({ minimum: 0, description: "上一次 todo 返回的 revision；第一次为 0" });
const TaskId = Type.String({ pattern: "^t[1-9][0-9]*$", description: "任务稳定 ID，例如 t3" });
const TaskTitle = Type.String({ minLength: 1, maxLength: MAX_TASK_TITLE_LENGTH });
const TodoParams = Type.Union([
	Type.Object({ operation: Type.Literal("view") }, { additionalProperties: false }),
	Type.Object(
		{
			operation: Type.Literal("set_plan"),
			expected_revision: ExpectedRevision,
			phases: Type.Array(
				Type.Object(
					{
						title: TaskTitle,
						tasks: Type.Array(TaskTitle, { minItems: 1, maxItems: MAX_TASKS }),
					},
					{ additionalProperties: false },
				),
				{ maxItems: MAX_TASK_PHASES },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("add"),
			expected_revision: ExpectedRevision,
			phase: Type.String({ minLength: 1, maxLength: MAX_TASK_TITLE_LENGTH, description: "阶段 ID 或名称" }),
			tasks: Type.Array(TaskTitle, { minItems: 1, maxItems: MAX_TASKS }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("start"), expected_revision: ExpectedRevision, task_id: TaskId },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("complete"),
			expected_revision: ExpectedRevision,
			task_id: TaskId,
			evidence: Type.String({
				minLength: 1,
				maxLength: MAX_TASK_NOTE_LENGTH,
				description: "简短的测试、检查、提交或观察结果",
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("block"),
			expected_revision: ExpectedRevision,
			task_id: TaskId,
			reason: Type.String({ minLength: 1, maxLength: MAX_TASK_NOTE_LENGTH, description: "具体阻塞原因" }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("unblock"), expected_revision: ExpectedRevision, task_id: TaskId },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("abandon"), expected_revision: ExpectedRevision, task_id: TaskId },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("reopen"), expected_revision: ExpectedRevision, task_id: TaskId },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("remove"), expected_revision: ExpectedRevision, task_id: TaskId },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("clear"), expected_revision: ExpectedRevision },
		{ additionalProperties: false },
	),
]);

type TodoParams = Static<typeof TodoParams>;

interface TodoDetails {
	state: TaskLedgerState;
}

function loadState(ctx: ExtensionContext): TaskLedgerState {
	return loadLatestTaskLedgerState(ctx.sessionManager.getBranch());
}

function updateWidget(ctx: ExtensionContext, state: TaskLedgerState): void {
	if (!ctx.hasUI) return;
	const widget = formatTaskLedgerWidget(state);
	ctx.ui.setWidget("task-ledger", widget === undefined ? undefined : [widget], { placement: "belowEditor" });
}

export default function taskLedgerExtension(pi: ExtensionAPI): void {
	pi.registerTool<typeof TodoParams, TodoDetails>({
		name: "todo",
		label: "任务计划",
		description: "保存多步骤任务的计划、当前进度、阻塞原因和完成证据。",
		promptSnippet: "用稳定任务 ID 管理长任务进度，并在完成时记录验证证据",
		promptGuidelines: [
			"只在需要多个步骤、会修改多个文件或可能跨上下文的任务中使用 todo；简单问答和单步操作不要使用。",
			"开始长任务时先 view；没有计划时用 set_plan 和 expected_revision=0，已有计划时沿用返回的 revision。",
			"每次修改使用最新 revision 和稳定 task_id；revision 冲突时 view 后最多重试一次。",
			"只有真正验证完成后才调用 complete，并写入简短、具体的测试或检查证据。",
			"遇到真实外部阻塞时使用 block，不要为了更新进度强制继续额外模型轮次。",
		],
		parameters: TodoParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			if (params.operation === "view") {
				return { content: [{ type: "text", text: formatTaskLedger(state) }], details: { state } };
			}
			const next = reduceTaskLedger(state, params as TaskLedgerAction);
			pi.appendEntry(TASK_LEDGER_ENTRY_TYPE, next);
			updateWidget(ctx, next);
			return { content: [{ type: "text", text: formatTaskLedger(next) }], details: { state: next } };
		},
	});

	pi.registerCommand("tasks", {
		description: "查看完整任务计划",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatTaskLedger(loadState(ctx)), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => updateWidget(ctx, loadState(ctx)));
	pi.on("session_tree", (_event, ctx) => updateWidget(ctx, loadState(ctx)));
	pi.on("before_agent_start", (event, ctx) => {
		const state = loadState(ctx);
		const content = formatTaskLedgerContext(state);
		if (content === undefined) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget("task-ledger", undefined, { placement: "belowEditor" });
	});
}
