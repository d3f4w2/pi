import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createEvalExtension } from "../src/extensions/eval/index.ts";
import {
	bunExecutableCandidates,
	capEvalResponse,
	type EvalWorkerFactory,
	type EvalWorkerLike,
	PersistentEvalManager,
	sanitizedEvalEnvironment,
} from "../src/extensions/eval/process.ts";
import type { EvalExecutionResult, EvalLanguage, EvalRuntimeService } from "../src/extensions/eval/types.ts";

class FakeWorker implements EvalWorkerLike {
	running = true;
	stopCalls = 0;
	executions: string[] = [];

	async execute(code: string): Promise<{ ok: boolean; stdout: string; stderr: string; value: string }> {
		this.executions.push(code);
		return { ok: true, stdout: "", stderr: "", value: String(this.executions.length) };
	}

	async stop(): Promise<void> {
		this.running = false;
		this.stopCalls++;
	}

	isRunning(): boolean {
		return this.running;
	}
}

describe("persistent eval manager", () => {
	it("reuses one worker per language and restarts when the project changes", async () => {
		const workers: FakeWorker[] = [];
		const factory: EvalWorkerFactory = () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		};
		const manager = new PersistentEvalManager(factory);

		const first = await manager.execute("python", "value = 1", "C:/one", 1_000);
		const second = await manager.execute("python", "value + 1", "C:/one", 1_000);
		const third = await manager.execute("python", "value = 3", "C:/two", 1_000);

		expect(first.restarted).toBe(true);
		expect(second.restarted).toBe(false);
		expect(third.restarted).toBe(true);
		expect(workers).toHaveLength(2);
		expect(workers[0]?.stopCalls).toBe(1);
	});

	it("removes likely credentials from the child environment", () => {
		expect(
			sanitizedEvalEnvironment({
				PATH: "keep",
				OPENAI_API_KEY: "remove",
				ACCESS_TOKEN: "remove",
				DATABASE_PASSWORD: "remove",
				PI_PROVIDER: "keep",
			}),
		).toEqual({ PATH: "keep", PI_PROVIDER: "keep" });
	});

	it("finds the real Bun executable behind Windows command wrappers", () => {
		const candidates = bunExecutableCandidates(
			{ APPDATA: "C:/Users/demo/AppData/Roaming", BUN_INSTALL: "C:/Users/demo/.bun" },
			"win32",
			"C:/Users/demo",
			(candidate) => candidate.includes("node_modules") && candidate.endsWith("bun.exe"),
		);
		expect(candidates[0]?.replaceAll("\\", "/")).toContain("node_modules/bun/bin/bun.exe");
		expect(candidates).toContain("bun.exe");
		expect(candidates).toContain("bun");
	});

	it("caps the combined model-facing output", () => {
		const result = capEvalResponse(
			{ ok: true, stdout: "a".repeat(20), stderr: "b".repeat(20), value: "c".repeat(20) },
			25,
		);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(`${result.stdout}${result.stderr}${result.value}`, "utf8")).toBeLessThanOrEqual(25);
	});
});

describe("eval extension", () => {
	it("registers one exec-approved tool and forwards execution", async () => {
		const tools: ToolDefinition[] = [];
		const service: EvalRuntimeService = {
			execute: vi.fn(
				async (): Promise<EvalExecutionResult> => ({
					ok: true,
					stdout: "answer",
					stderr: "",
					value: "42",
					language: "python",
					durationMs: 5,
					restarted: true,
					truncated: false,
				}),
			),
			reset: vi.fn(async () => []),
			status: vi.fn((): EvalLanguage[] => ["python"]),
			stopAll: vi.fn(async () => {}),
		};
		createEvalExtension(service)({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: () => {},
		} as unknown as ExtensionAPI);

		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "eval", approval: { tier: "exec" }, executionMode: "sequential" });
		const result = await tools[0]?.execute(
			"call",
			{ operation: "execute", language: "python", code: "6 * 7" },
			undefined,
			undefined,
			{ cwd: "C:/repo" } as ExtensionContext,
		);
		expect(service.execute).toHaveBeenCalledWith("python", "6 * 7", "C:/repo", 10_000, undefined);
		expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("42") });
	});
});
