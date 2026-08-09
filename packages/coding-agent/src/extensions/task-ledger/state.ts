import { Compile } from "typebox/compile";
import type { SessionEntry } from "../../core/session-manager.ts";
import {
	MAX_TASK_NOTE_LENGTH,
	MAX_TASK_PHASES,
	MAX_TASK_TITLE_LENGTH,
	MAX_TASKS,
	TASK_LEDGER_ENTRY_TYPE,
	TASK_LEDGER_SCHEMA_VERSION,
	type TaskItem,
	type TaskLedgerAction,
	type TaskLedgerState,
	TaskLedgerStateSchema,
	type TaskPhase,
} from "./types.ts";

const taskLedgerValidator = Compile(TaskLedgerStateSchema);

export function createEmptyTaskLedger(): TaskLedgerState {
	return {
		schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
		revision: 0,
		nextPhaseNumber: 1,
		nextTaskNumber: 1,
		phases: [],
	};
}

function cloneTask(task: TaskItem): TaskItem {
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		...(task.evidence === undefined ? {} : { evidence: task.evidence }),
		...(task.blocker === undefined ? {} : { blocker: task.blocker }),
	};
}

function cloneState(state: TaskLedgerState): TaskLedgerState {
	return {
		schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
		revision: state.revision,
		nextPhaseNumber: state.nextPhaseNumber,
		nextTaskNumber: state.nextTaskNumber,
		phases: state.phases.map((phase) => ({
			id: phase.id,
			title: phase.title,
			tasks: phase.tasks.map(cloneTask),
		})),
	};
}

function normalizeText(value: string, label: string, maxLength: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (!normalized) throw new Error(`${label}不能为空`);
	if (normalized.length > maxLength) throw new Error(`${label}最多 ${maxLength} 个字符`);
	return normalized;
}

function findTask(state: TaskLedgerState, taskId: string): { phase: TaskPhase; task: TaskItem } {
	for (const phase of state.phases) {
		const task = phase.tasks.find((candidate) => candidate.id === taskId);
		if (task) return { phase, task };
	}
	throw new Error(`找不到任务 ${taskId}`);
}

function taskCount(state: TaskLedgerState): number {
	return state.phases.reduce((count, phase) => count + phase.tasks.length, 0);
}

function activateNextPendingTask(state: TaskLedgerState): void {
	if (state.phases.some((phase) => phase.tasks.some((task) => task.status === "in_progress"))) return;
	for (const phase of state.phases) {
		const task = phase.tasks.find((candidate) => candidate.status === "pending");
		if (task) {
			task.status = "in_progress";
			return;
		}
	}
}

function validateState(state: TaskLedgerState): void {
	if (!taskLedgerValidator.Check(state)) throw new Error("任务状态格式无效");
	if (taskCount(state) > MAX_TASKS) throw new Error(`最多 ${MAX_TASKS} 个任务`);
	const phaseTitles = new Set<string>();
	let largestPhaseNumber = 0;
	let largestTaskNumber = 0;
	const activeCount = state.phases.reduce((count, phase) => {
		const phaseTitle = phase.title.toLowerCase();
		if (phaseTitles.has(phaseTitle)) throw new Error("阶段名称不能重复");
		phaseTitles.add(phaseTitle);
		largestPhaseNumber = Math.max(largestPhaseNumber, Number(phase.id.slice(1)));
		for (const task of phase.tasks) {
			largestTaskNumber = Math.max(largestTaskNumber, Number(task.id.slice(1)));
			if (task.status === "completed" && task.evidence === undefined) throw new Error("已完成任务缺少证据");
			if (task.status !== "completed" && task.evidence !== undefined) throw new Error("未完成任务不能包含完成证据");
			if (task.status === "blocked" && task.blocker === undefined) throw new Error("阻塞任务缺少原因");
			if (task.status !== "blocked" && task.blocker !== undefined) throw new Error("非阻塞任务不能包含阻塞原因");
		}
		return count + phase.tasks.filter((task) => task.status === "in_progress").length;
	}, 0);
	if (activeCount > 1) throw new Error("同一时间只能有一个进行中的任务");
	if (state.nextPhaseNumber <= largestPhaseNumber || state.nextTaskNumber <= largestTaskNumber) {
		throw new Error("任务 ID 计数器无效");
	}
}

function replacePlan(state: TaskLedgerState, action: Extract<TaskLedgerAction, { operation: "set_plan" }>): void {
	if (action.phases.length > MAX_TASK_PHASES) throw new Error(`最多 ${MAX_TASK_PHASES} 个阶段`);
	const totalTasks = action.phases.reduce((count, phase) => count + phase.tasks.length, 0);
	if (totalTasks > MAX_TASKS) throw new Error(`最多 ${MAX_TASKS} 个任务`);
	const seenTitles = new Set<string>();
	const phases: TaskPhase[] = [];
	for (const input of action.phases) {
		const title = normalizeText(input.title, "阶段名称", MAX_TASK_TITLE_LENGTH);
		const key = title.toLocaleLowerCase();
		if (seenTitles.has(key)) throw new Error("阶段名称不能重复");
		seenTitles.add(key);
		if (input.tasks.length === 0) throw new Error(`阶段“${title}”至少需要一个任务`);
		const phase: TaskPhase = { id: `p${state.nextPhaseNumber}`, title, tasks: [] };
		state.nextPhaseNumber += 1;
		for (const inputTask of input.tasks) {
			phase.tasks.push({
				id: `t${state.nextTaskNumber}`,
				title: normalizeText(inputTask, "任务标题", MAX_TASK_TITLE_LENGTH),
				status: "pending",
			});
			state.nextTaskNumber += 1;
		}
		phases.push(phase);
	}
	state.phases = phases;
}

function addTasks(state: TaskLedgerState, action: Extract<TaskLedgerAction, { operation: "add" }>): void {
	if (action.tasks.length === 0) throw new Error("至少需要添加一个任务");
	if (taskCount(state) + action.tasks.length > MAX_TASKS) throw new Error(`最多 ${MAX_TASKS} 个任务`);
	const phaseKey = normalizeText(action.phase, "阶段名称或 ID", MAX_TASK_TITLE_LENGTH);
	let phase = state.phases.find(
		(candidate) => candidate.id === phaseKey || candidate.title.toLocaleLowerCase() === phaseKey.toLocaleLowerCase(),
	);
	if (!phase) {
		if (state.phases.length >= MAX_TASK_PHASES) throw new Error(`最多 ${MAX_TASK_PHASES} 个阶段`);
		phase = { id: `p${state.nextPhaseNumber}`, title: phaseKey, tasks: [] };
		state.nextPhaseNumber += 1;
		state.phases.push(phase);
	}
	for (const inputTask of action.tasks) {
		phase.tasks.push({
			id: `t${state.nextTaskNumber}`,
			title: normalizeText(inputTask, "任务标题", MAX_TASK_TITLE_LENGTH),
			status: "pending",
		});
		state.nextTaskNumber += 1;
	}
}

export function reduceTaskLedger(state: TaskLedgerState, action: TaskLedgerAction): TaskLedgerState {
	if (action.expected_revision !== state.revision) {
		throw new Error(`任务状态已变化，当前 revision 为 ${state.revision}；请先调用 todo view`);
	}
	const next = cloneState(state);
	switch (action.operation) {
		case "set_plan":
			replacePlan(next, action);
			break;
		case "add":
			addTasks(next, action);
			break;
		case "start": {
			const { task } = findTask(next, action.task_id);
			if (task.status !== "pending" && task.status !== "in_progress") {
				throw new Error(`任务 ${task.id} 当前为 ${task.status}，请先解除阻塞或重新打开`);
			}
			for (const phase of next.phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress") candidate.status = "pending";
				}
			}
			task.status = "in_progress";
			break;
		}
		case "complete": {
			const evidence = normalizeText(action.evidence, "完成证据", MAX_TASK_NOTE_LENGTH);
			const { task } = findTask(next, action.task_id);
			if (task.status !== "in_progress")
				throw new Error(`只有进行中的任务可以完成，${task.id} 当前为 ${task.status}`);
			task.status = "completed";
			task.evidence = evidence;
			delete task.blocker;
			break;
		}
		case "block": {
			const reason = normalizeText(action.reason, "阻塞原因", MAX_TASK_NOTE_LENGTH);
			const { task } = findTask(next, action.task_id);
			if (task.status !== "pending" && task.status !== "in_progress") {
				throw new Error(`只有待办或进行中的任务可以阻塞，${task.id} 当前为 ${task.status}`);
			}
			task.status = "blocked";
			task.blocker = reason;
			delete task.evidence;
			break;
		}
		case "unblock": {
			const { task } = findTask(next, action.task_id);
			if (task.status !== "blocked") throw new Error(`任务 ${task.id} 当前没有被阻塞`);
			task.status = "pending";
			delete task.blocker;
			break;
		}
		case "abandon": {
			const { task } = findTask(next, action.task_id);
			if (task.status === "completed" || task.status === "abandoned") {
				throw new Error(`任务 ${task.id} 当前为 ${task.status}，不能放弃`);
			}
			task.status = "abandoned";
			delete task.blocker;
			delete task.evidence;
			break;
		}
		case "reopen": {
			const { task } = findTask(next, action.task_id);
			if (task.status !== "completed" && task.status !== "abandoned") {
				throw new Error(`只有已完成或已放弃任务可以重新打开，${task.id} 当前为 ${task.status}`);
			}
			task.status = "pending";
			delete task.evidence;
			delete task.blocker;
			break;
		}
		case "remove": {
			findTask(next, action.task_id);
			next.phases = next.phases
				.map((phase) => ({ ...phase, tasks: phase.tasks.filter((task) => task.id !== action.task_id) }))
				.filter((phase) => phase.tasks.length > 0);
			break;
		}
		case "clear":
			next.phases = [];
			break;
	}
	activateNextPendingTask(next);
	next.revision += 1;
	validateState(next);
	return next;
}

export function loadLatestTaskLedgerState(entries: readonly SessionEntry[]): TaskLedgerState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== TASK_LEDGER_ENTRY_TYPE) continue;
		if (!taskLedgerValidator.Check(entry.data)) continue;
		try {
			validateState(entry.data);
			return cloneState(entry.data);
		} catch {}
	}
	return createEmptyTaskLedger();
}

export interface TaskLedgerStats {
	total: number;
	completed: number;
	blocked: number;
	abandoned: number;
	active?: TaskItem;
}

export function getTaskLedgerStats(state: TaskLedgerState): TaskLedgerStats {
	const tasks = state.phases.flatMap((phase) => phase.tasks);
	const active = tasks.find((task) => task.status === "in_progress");
	return {
		total: tasks.length,
		completed: tasks.filter((task) => task.status === "completed").length,
		blocked: tasks.filter((task) => task.status === "blocked").length,
		abandoned: tasks.filter((task) => task.status === "abandoned").length,
		...(active === undefined ? {} : { active }),
	};
}

const statusSymbols: Record<TaskItem["status"], string> = {
	pending: "○",
	in_progress: "→",
	completed: "✓",
	blocked: "!",
	abandoned: "-",
};

export function formatTaskLedger(state: TaskLedgerState): string {
	const stats = getTaskLedgerStats(state);
	if (stats.total === 0) return `任务计划 r${state.revision} · 暂无任务`;
	const lines = [`任务计划 r${state.revision} · ${stats.completed}/${stats.total} 完成`];
	for (const phase of state.phases) {
		lines.push(`\n${phase.id} ${phase.title}`);
		for (const task of phase.tasks) {
			lines.push(`  ${statusSymbols[task.status]} ${task.id} ${task.title}`);
			if (task.blocker) lines.push(`    阻塞：${task.blocker}`);
			if (task.evidence) lines.push(`    证据：${task.evidence}`);
		}
	}
	return lines.join("\n");
}

export function formatTaskLedgerWidget(state: TaskLedgerState): string | undefined {
	const stats = getTaskLedgerStats(state);
	if (stats.total === 0) return undefined;
	const active = stats.active ? ` · 当前 ${stats.active.id} ${stats.active.title}` : "";
	const blocked = stats.blocked > 0 ? ` · 阻塞 ${stats.blocked}` : "";
	return `任务 ${stats.completed}/${stats.total}${active}${blocked}`;
}

export function formatTaskLedgerContext(state: TaskLedgerState, maxCharacters = 2400): string | undefined {
	const stats = getTaskLedgerStats(state);
	if (stats.total === 0) return undefined;
	const openTasks = state.phases
		.flatMap((phase) => phase.tasks.map((task) => ({ phase: phase.title, task })))
		.filter(({ task }) => task.status === "in_progress" || task.status === "pending" || task.status === "blocked")
		.slice(0, 12);
	const lines = [
		`[任务状态 r${state.revision}] ${stats.completed}/${stats.total} 完成，${stats.blocked} 阻塞，${stats.abandoned} 放弃。`,
		"处理多步骤任务时以此状态为准；完成后必须用 todo complete 写入简短验证证据。",
	];
	for (const { phase, task } of openTasks) {
		const blocker = task.blocker ? `（阻塞：${task.blocker}）` : "";
		lines.push(`${statusSymbols[task.status]} ${task.id} [${phase}] ${task.title}${blocker}`);
	}
	const text = lines.join("\n");
	return text.length <= maxCharacters ? text : `${text.slice(0, Math.max(0, maxCharacters - 1))}…`;
}
