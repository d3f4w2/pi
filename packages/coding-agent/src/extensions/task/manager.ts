import { randomUUID } from "node:crypto";
import type { TaskWorkerRunResult, TaskWorkerSnapshot, TaskWorkerStartRequest } from "./types.ts";

interface TaskWorkerRecord {
	snapshot: TaskWorkerSnapshot;
	controller: AbortController;
	promise: Promise<void>;
	timeout: ReturnType<typeof setTimeout>;
	abortKind?: "cancel" | "timeout";
}

export interface TaskWorkerManagerOptions {
	maxWorkers?: number;
	maxResultBytes?: number;
}

const DEFAULT_MAX_WORKERS = 3;
const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
	let output = "";
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		output += character;
		bytes += size;
	}
	return { value: output, truncated: true };
}

function boundedResult(result: TaskWorkerRunResult, maxBytes: number): TaskWorkerRunResult {
	const output = truncateUtf8(result.output, maxBytes);
	return {
		...result,
		output: output.value,
		changedFiles: result.changedFiles.slice(0, 1_000),
		verification: result.verification.slice(0, 100),
		truncated: result.truncated === true || output.truncated,
	};
}

function cloneSnapshot(snapshot: TaskWorkerSnapshot): TaskWorkerSnapshot {
	return structuredClone(snapshot);
}

export class TaskWorkerManager {
	private readonly maxWorkers: number;
	private readonly maxResultBytes: number;
	private readonly records = new Map<string, TaskWorkerRecord>();

	constructor(options: TaskWorkerManagerOptions = {}) {
		this.maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
		this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
		if (!Number.isInteger(this.maxWorkers) || this.maxWorkers < 1) throw new Error("maxWorkers must be positive");
		if (!Number.isInteger(this.maxResultBytes) || this.maxResultBytes < 1) {
			throw new Error("maxResultBytes must be positive");
		}
	}

	start(
		request: TaskWorkerStartRequest,
		runner: (signal: AbortSignal) => Promise<TaskWorkerRunResult>,
	): TaskWorkerSnapshot {
		if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1) throw new Error("timeoutMs must be positive");
		const running = [...this.records.values()].filter((record) => record.snapshot.status === "running").length;
		if (running >= this.maxWorkers) throw new Error(`At most ${this.maxWorkers} task workers may run concurrently`);

		const id = `task-${randomUUID()}`;
		const controller = new AbortController();
		const snapshot: TaskWorkerSnapshot = {
			id,
			status: "running",
			profile: request.profile,
			prompt: request.prompt,
			startedAt: new Date().toISOString(),
		};
		const record: TaskWorkerRecord = {
			snapshot,
			controller,
			promise: Promise.resolve(),
			timeout: setTimeout(() => {}, 0),
		};
		record.timeout = setTimeout(() => {
			record.abortKind = "timeout";
			controller.abort(new Error(`Task worker timed out after ${request.timeoutMs} ms`));
		}, request.timeoutMs);
		record.timeout.unref?.();
		record.promise = this.run(record, runner);
		this.records.set(id, record);
		return cloneSnapshot(snapshot);
	}

	private async run(
		record: TaskWorkerRecord,
		runner: (signal: AbortSignal) => Promise<TaskWorkerRunResult>,
	): Promise<void> {
		let removeAbortListener = () => {};
		try {
			const aborted = new Promise<never>((_resolve, reject) => {
				const onAbort = () => reject(record.controller.signal.reason ?? new Error("Task worker aborted"));
				if (record.controller.signal.aborted) onAbort();
				else {
					record.controller.signal.addEventListener("abort", onAbort, { once: true });
					removeAbortListener = () => record.controller.signal.removeEventListener("abort", onAbort);
				}
			});
			const result = await Promise.race([runner(record.controller.signal), aborted]);
			if (record.controller.signal.aborted) throw record.controller.signal.reason;
			record.snapshot.status = "completed";
			record.snapshot.result = boundedResult(result, this.maxResultBytes);
		} catch (error) {
			if (record.abortKind === "cancel") {
				record.snapshot.status = "cancelled";
			} else {
				record.snapshot.status = "failed";
				record.snapshot.error = truncateUtf8(errorMessage(error), this.maxResultBytes).value;
			}
		} finally {
			removeAbortListener();
			clearTimeout(record.timeout);
			record.snapshot.endedAt = new Date().toISOString();
		}
	}

	status(id?: string): TaskWorkerSnapshot[] {
		if (id !== undefined) return [cloneSnapshot(this.getRecord(id).snapshot)];
		return [...this.records.values()].map((record) => cloneSnapshot(record.snapshot));
	}

	result(id: string): TaskWorkerSnapshot {
		return cloneSnapshot(this.getRecord(id).snapshot);
	}

	async cancel(id: string): Promise<TaskWorkerSnapshot> {
		const record = this.getRecord(id);
		if (record.snapshot.status === "running") {
			record.abortKind = "cancel";
			record.controller.abort(new Error("Task worker cancelled"));
			await record.promise;
		}
		return cloneSnapshot(record.snapshot);
	}

	async stopAll(): Promise<void> {
		await Promise.all(
			[...this.records.values()]
				.filter((record) => record.snapshot.status === "running")
				.map((record) => this.cancel(record.snapshot.id)),
		);
	}

	async waitForIdle(): Promise<void> {
		await Promise.all([...this.records.values()].map((record) => record.promise));
	}

	private getRecord(id: string): TaskWorkerRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown task worker: ${id}`);
		return record;
	}
}
