import { mutationPaths, type ObservedToolResult, verificationOutcome } from "../execution-controller/policy.ts";
import type { RunMetricRecord, RunOutcome, ToolRunUsage } from "./types.ts";

function boundedToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100) || "unknown";
}

export class RunMetricsTracker {
	private startedAt = 0;
	private turns = 0;
	private revision = 0;
	private verifiedRevision = 0;
	private lastVerification: "passed" | "failed" | "waived" | undefined;
	private aborted = false;
	private active = false;
	private tools = new Map<string, ToolRunUsage>();

	start(now = Date.now()): void {
		this.startedAt = now;
		this.turns = 0;
		this.revision = 0;
		this.verifiedRevision = 0;
		this.lastVerification = undefined;
		this.aborted = false;
		this.active = true;
		this.tools.clear();
	}

	recordTurn(): void {
		if (this.active) this.turns++;
	}

	recordTool(event: ObservedToolResult): void {
		if (!this.active) return;
		const name = boundedToolName(event.toolName);
		const usage = this.tools.get(name) ?? { calls: 0, errors: 0 };
		usage.calls++;
		if (event.isError) usage.errors++;
		this.tools.set(name, usage);

		if (mutationPaths(event).length > 0) {
			this.revision++;
			this.lastVerification = undefined;
		}
		const outcome = verificationOutcome(event);
		if (outcome === undefined || this.revision === 0) return;
		this.lastVerification = outcome;
		if (outcome === "passed") this.verifiedRevision = this.revision;
	}

	markAborted(): void {
		if (this.active) this.aborted = true;
	}

	finish(now = Date.now()): RunMetricRecord | undefined {
		if (!this.active) return undefined;
		this.active = false;
		let outcome: RunOutcome;
		if (this.aborted) outcome = "aborted";
		else if (this.revision === 0) outcome = "completed";
		else if (this.verifiedRevision === this.revision) outcome = "verified";
		else if (this.lastVerification === "failed") outcome = "failed";
		else outcome = "unverified";
		return {
			version: 1,
			startedAt: new Date(this.startedAt).toISOString(),
			durationMs: Math.max(0, now - this.startedAt),
			turns: this.turns,
			taskKind: this.revision > 0 ? "code_change" : "read_only",
			outcome,
			tools: Object.fromEntries([...this.tools.entries()].map(([name, usage]) => [name, { ...usage }])),
		};
	}
}
