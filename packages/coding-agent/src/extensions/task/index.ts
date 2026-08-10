import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import type { TaskWorkerService, TaskWorkerSnapshot } from "./types.ts";
import { TaskWorkerRuntime } from "./worker.ts";

const TaskParams = Type.Union([
	Type.Object(
		{
			operation: Type.Literal("start"),
			prompt: Type.String({ minLength: 1, maxLength: 20_000, description: "独立子任务的完整目标" }),
			profile: Type.Optional(Type.Union([Type.Literal("research"), Type.Literal("coding")])),
			timeout_seconds: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 1_800, description: "硬超时，默认 300 秒" }),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("status"), task_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("result"), task_id: Type.String({ minLength: 1, maxLength: 100 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ operation: Type.Literal("cancel"), task_id: Type.String({ minLength: 1, maxLength: 100 }) },
		{ additionalProperties: false },
	),
]);

function operationOf(args: unknown): "start" | "status" | "result" | "cancel" | "unknown" {
	if (typeof args !== "object" || args === null) return "unknown";
	const operation = Reflect.get(args, "operation");
	return operation === "start" || operation === "status" || operation === "result" || operation === "cancel"
		? operation
		: "unknown";
}

function formatSnapshots(snapshots: TaskWorkerSnapshot[]): string {
	if (snapshots.length === 0) return "No task workers have been started.";
	return snapshots
		.map((snapshot) => {
			const suffix = snapshot.error ? `\nError: ${snapshot.error}` : "";
			return `${snapshot.id} · ${snapshot.profile} · ${snapshot.status}${suffix}`;
		})
		.join("\n");
}

export function createTaskExtension(service: TaskWorkerService): (pi: ExtensionAPI) => void {
	return (pi) => {
		const definition: ToolDefinition<typeof TaskParams, TaskWorkerSnapshot | TaskWorkerSnapshot[]> = {
			name: "task",
			label: "隔离任务 worker",
			description: "在独立项目快照中启动最多三个受限任务，查询结果或取消任务；修改不会自动合并。",
			discovery: {
				keywords: ["并行任务", "子任务", "独立研究", "隔离编码", "task worker", "parallel research"],
			},
			promptSnippet: "在独立快照中并行执行受限研究或编码任务，并查询有界结果。",
			promptGuidelines: [
				"仅把可独立执行、边界明确的工作交给 task；最多同时运行三个。",
				"coding 任务的修改留在返回的 workspacePath，不会自动合并；必须在父工作区复核后手动应用。",
				"启动后用 status/result 查询，不要重复启动相同任务。",
			],
			parameters: TaskParams,
			executionMode: "sequential",
			approval: (args) =>
				operationOf(args) === "status" || operationOf(args) === "result"
					? { tier: "read", reason: "读取本会话任务状态或结果" }
					: { tier: "exec", reason: "启动或取消隔离任务 worker" },
			formatApprovalDetails: (args) => {
				if (typeof args !== "object" || args === null) return [];
				const prompt = Reflect.get(args, "prompt");
				const taskId = Reflect.get(args, "task_id");
				return [
					`操作：${operationOf(args)}`,
					...(typeof prompt === "string" ? [`任务：${prompt.slice(0, 200)}`] : []),
					...(typeof taskId === "string" ? [`ID：${taskId}`] : []),
				];
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (params.operation === "start") {
					const snapshot = service.start(
						{
							prompt: params.prompt,
							profile: params.profile ?? "research",
							timeoutMs: (params.timeout_seconds ?? 300) * 1_000,
						},
						{ cwd: ctx.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel },
					);
					return {
						content: [{ type: "text", text: `Started ${snapshot.id}. Use task status/result to inspect it.` }],
						details: snapshot,
					};
				}
				if (params.operation === "status") {
					const snapshots = service.status(params.task_id);
					return { content: [{ type: "text", text: formatSnapshots(snapshots) }], details: snapshots };
				}
				if (params.operation === "result") {
					const snapshot = service.result(params.task_id);
					return {
						content: [{ type: "text", text: snapshot.result?.output ?? formatSnapshots([snapshot]) }],
						details: snapshot,
					};
				}
				const snapshot = await service.cancel(params.task_id);
				return { content: [{ type: "text", text: formatSnapshots([snapshot]) }], details: snapshot };
			},
		};
		pi.registerTool(definition);
		pi.on("session_shutdown", () => service.stopAll());
	};
}

export default createTaskExtension(new TaskWorkerRuntime());
