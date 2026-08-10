import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createTaskExtension } from "../src/extensions/task/index.ts";
import { TaskWorkerManager } from "../src/extensions/task/manager.ts";
import type {
	TaskWorkerLaunchContext,
	TaskWorkerRunResult,
	TaskWorkerService,
	TaskWorkerStartRequest,
} from "../src/extensions/task/types.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const completedResult: TaskWorkerRunResult = {
	output: "done",
	changedFiles: [],
	verification: ["focused tests passed"],
	usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, toolCalls: 1 },
	workspacePath: "C:/tmp/pi-task-worker-test/workspace",
};

describe("TaskWorkerManager", () => {
	it("enforces the three-worker concurrency limit", async () => {
		const manager = new TaskWorkerManager({ maxWorkers: 3 });
		const runs = [deferred<TaskWorkerRunResult>(), deferred<TaskWorkerRunResult>(), deferred<TaskWorkerRunResult>()];
		for (const [index, run] of runs.entries()) {
			manager.start({ prompt: `task ${index}`, profile: "research", timeoutMs: 5_000 }, async () => run.promise);
		}

		expect(() =>
			manager.start({ prompt: "fourth", profile: "research", timeoutMs: 5_000 }, async () => completedResult),
		).toThrow("3");
		for (const run of runs) run.resolve(completedResult);
		await manager.waitForIdle();
		expect(manager.status().every((worker) => worker.status === "completed")).toBe(true);
	});

	it("cancels a running worker and bounds model-facing output", async () => {
		const manager = new TaskWorkerManager({ maxResultBytes: 64 });
		const worker = manager.start({ prompt: "wait", profile: "coding", timeoutMs: 5_000 }, async (signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			return completedResult;
		});
		await manager.cancel(worker.id);
		await manager.waitForIdle();
		expect(manager.result(worker.id).status).toBe("cancelled");

		const completed = manager.start({ prompt: "large", profile: "research", timeoutMs: 5_000 }, async () => ({
			...completedResult,
			output: "x".repeat(1_000),
		}));
		await manager.waitForIdle();
		const result = manager.result(completed.id);
		expect(result.status).toBe("completed");
		expect(Buffer.byteLength(result.result?.output ?? "", "utf8")).toBeLessThanOrEqual(64);
		expect(result.result?.truncated).toBe(true);
	});

	it("enforces a hard timeout even when a runner ignores abort", async () => {
		const manager = new TaskWorkerManager();
		const worker = manager.start(
			{ prompt: "hang", profile: "research", timeoutMs: 10 },
			async () => new Promise<TaskWorkerRunResult>(() => {}),
		);
		await manager.waitForIdle();
		expect(manager.result(worker.id)).toMatchObject({
			status: "failed",
			error: expect.stringContaining("timed out"),
		});
	});
});

describe("task extension", () => {
	it("registers bounded start/status/result/cancel operations with dynamic approval", async () => {
		let definition: ToolDefinition | undefined;
		const start = vi.fn((_request: TaskWorkerStartRequest, _context: TaskWorkerLaunchContext) => ({
			id: "worker-1",
			status: "running" as const,
			profile: "research" as const,
			prompt: "inspect",
			startedAt: new Date(0).toISOString(),
		}));
		const service: TaskWorkerService = {
			start,
			status: vi.fn(() => []),
			result: vi.fn(() => ({
				id: "worker-1",
				status: "completed" as const,
				profile: "research" as const,
				prompt: "inspect",
				startedAt: new Date(0).toISOString(),
				endedAt: new Date(1).toISOString(),
				result: completedResult,
			})),
			cancel: vi.fn(async () => ({
				id: "worker-1",
				status: "cancelled" as const,
				profile: "research" as const,
				prompt: "inspect",
				startedAt: new Date(0).toISOString(),
				endedAt: new Date(1).toISOString(),
			})),
			stopAll: vi.fn(async () => {}),
		};
		createTaskExtension(service)({
			registerTool: (tool: ToolDefinition) => {
				definition = tool;
			},
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as unknown as ExtensionAPI);

		expect(definition?.name).toBe("task");
		if (typeof definition?.approval !== "function") throw new Error("task approval must be dynamic");
		expect(definition.approval({ operation: "status" })).toMatchObject({ tier: "read" });
		expect(definition.approval({ operation: "start" })).toMatchObject({ tier: "exec" });

		await definition.execute(
			"call-1",
			{ operation: "start", prompt: "inspect", profile: "research" },
			undefined,
			undefined,
			{
				cwd: "C:/repo",
				model: { provider: "test", id: "model" },
				thinkingLevel: "off",
			} as ExtensionContext,
		);
		expect(start).toHaveBeenCalledWith(
			{ prompt: "inspect", profile: "research", timeoutMs: 300_000 },
			expect.objectContaining({ cwd: "C:/repo" }),
		);
	});
});
