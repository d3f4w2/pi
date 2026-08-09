import { type Static, Type } from "typebox";

export const TASK_LEDGER_ENTRY_TYPE = "task-ledger-v1";
export const TASK_LEDGER_SCHEMA_VERSION = 1;
export const MAX_TASK_PHASES = 8;
export const MAX_TASKS = 100;
export const MAX_TASK_TITLE_LENGTH = 160;
export const MAX_TASK_NOTE_LENGTH = 500;

export const TaskStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("blocked"),
	Type.Literal("abandoned"),
]);

export type TaskStatus = Static<typeof TaskStatusSchema>;

export const TaskItemSchema = Type.Object(
	{
		id: Type.String({ pattern: "^t[1-9][0-9]*$" }),
		title: Type.String({ minLength: 1, maxLength: MAX_TASK_TITLE_LENGTH }),
		status: TaskStatusSchema,
		evidence: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TASK_NOTE_LENGTH })),
		blocker: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TASK_NOTE_LENGTH })),
	},
	{ additionalProperties: false },
);

export type TaskItem = Static<typeof TaskItemSchema>;

export const TaskPhaseSchema = Type.Object(
	{
		id: Type.String({ pattern: "^p[1-9][0-9]*$" }),
		title: Type.String({ minLength: 1, maxLength: MAX_TASK_TITLE_LENGTH }),
		tasks: Type.Array(TaskItemSchema),
	},
	{ additionalProperties: false },
);

export type TaskPhase = Static<typeof TaskPhaseSchema>;

export const TaskLedgerStateSchema = Type.Object(
	{
		schemaVersion: Type.Literal(TASK_LEDGER_SCHEMA_VERSION),
		revision: Type.Integer({ minimum: 0 }),
		nextPhaseNumber: Type.Integer({ minimum: 1 }),
		nextTaskNumber: Type.Integer({ minimum: 1 }),
		phases: Type.Array(TaskPhaseSchema, { maxItems: MAX_TASK_PHASES }),
	},
	{ additionalProperties: false },
);

export type TaskLedgerState = Static<typeof TaskLedgerStateSchema>;

export interface TaskPlanInput {
	title: string;
	tasks: string[];
}

export type TaskLedgerAction =
	| { operation: "set_plan"; expected_revision: number; phases: TaskPlanInput[] }
	| { operation: "add"; expected_revision: number; phase: string; tasks: string[] }
	| { operation: "start"; expected_revision: number; task_id: string }
	| { operation: "complete"; expected_revision: number; task_id: string; evidence: string }
	| { operation: "block"; expected_revision: number; task_id: string; reason: string }
	| { operation: "unblock"; expected_revision: number; task_id: string }
	| { operation: "abandon"; expected_revision: number; task_id: string }
	| { operation: "reopen"; expected_revision: number; task_id: string }
	| { operation: "remove"; expected_revision: number; task_id: string }
	| { operation: "clear"; expected_revision: number };
