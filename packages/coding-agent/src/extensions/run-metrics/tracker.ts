import { randomUUID } from "node:crypto";
import type { StopReason, Usage } from "@earendil-works/pi-ai";
import { mutationPaths, type ObservedToolResult, verificationOutcome } from "../execution-controller/policy.ts";
import type { RunEvidence, RunOutcome, RunRecord, RunUsage, ToolRunUsage } from "./types.ts";

function boundedToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100) || "unknown";
}

export class RunMetricsTracker {
	private id = "";
	private startedAt = 0;
	private turns = 0;
	private failedTurns = 0;
	private lastTurnFailed = false;
	private revision = 0;
	private verifiedRevision = 0;
	private lastVerification: "passed" | "failed" | "waived" | undefined;
	private verificationChecks = 0;
	private aborted = false;
	private active = false;
	private tools = new Map<string, ToolRunUsage>();
	private usage: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

	start(now = Date.now(), id: string = randomUUID()): void {
		this.id = id;
		this.startedAt = now;
		this.turns = 0;
		this.failedTurns = 0;
		this.lastTurnFailed = false;
		this.revision = 0;
		this.verifiedRevision = 0;
		this.lastVerification = undefined;
		this.verificationChecks = 0;
		this.aborted = false;
		this.active = true;
		this.tools.clear();
		this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	}

	recordTurn(usage?: Usage, stopReason?: StopReason): void {
		if (!this.active) return;
		this.turns++;
		this.lastTurnFailed = stopReason === "error";
		if (this.lastTurnFailed) this.failedTurns++;
		if (!usage) return;
		this.usage.input += Math.max(0, usage.input);
		this.usage.output += Math.max(0, usage.output);
		this.usage.cacheRead += Math.max(0, usage.cacheRead);
		this.usage.cacheWrite += Math.max(0, usage.cacheWrite);
		this.usage.totalTokens += Math.max(0, usage.totalTokens);
		this.usage.cost += Math.max(0, usage.cost.total);
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
			this.verificationChecks = 0;
		}
		const outcome = verificationOutcome(event);
		if (outcome === undefined || this.revision === 0) return;
		this.lastVerification = outcome;
		if (typeof event.details === "object" && event.details !== null && "checks" in event.details) {
			const checks = (event.details as { checks?: unknown }).checks;
			this.verificationChecks = Array.isArray(checks) ? checks.length : 0;
		}
		if (outcome === "passed") this.verifiedRevision = this.revision;
	}

	markAborted(): void {
		if (this.active) this.aborted = true;
	}

	finish(now = Date.now()): RunRecord | undefined {
		if (!this.active) return undefined;
		this.active = false;
		let outcome: RunOutcome;
		const hasToolErrors = [...this.tools.values()].some((usage) => usage.errors > 0);
		if (this.aborted) outcome = "aborted";
		else if (this.revision === 0) outcome = hasToolErrors ? "failed" : "completed";
		else if (this.verifiedRevision === this.revision) outcome = "verified";
		else if (this.lastVerification === "failed") outcome = "failed";
		else outcome = "unverified";
		let verification: RunEvidence["verification"];
		if (this.revision === 0) verification = "not_needed";
		else if (this.verifiedRevision === this.revision) verification = "passed";
		else if (this.lastVerification === "failed") verification = "failed";
		else if (this.lastVerification === "waived") verification = "waived";
		else verification = "missing";
		return {
			version: 2,
			id: this.id,
			startedAt: new Date(this.startedAt).toISOString(),
			durationMs: Math.max(0, now - this.startedAt),
			turns: this.turns,
			retries: Math.max(0, this.failedTurns - (this.lastTurnFailed ? 1 : 0)),
			taskKind: this.revision > 0 ? "code_change" : "read_only",
			outcome,
			tools: Object.fromEntries([...this.tools.entries()].map(([name, usage]) => [name, { ...usage }])),
			usage: { ...this.usage },
			evidence: { verification, checks: this.verificationChecks },
		};
	}
}
