import { createHash } from "node:crypto";
import type { StopReason } from "@earendil-works/pi-ai";
import { mutationPaths, type ObservedToolResult, verificationOutcome } from "../execution-controller/policy.ts";
import type { RecoveredFailureKind, RecoveredFailureSignal } from "./types.ts";

const UNRESOLVED_TTL_MS = 10 * 60 * 1000;

interface FailureObservation {
	kind: RecoveredFailureKind;
	toolName?: string;
	detectedAt: number;
	mutationObserved: boolean;
	verificationPassed: boolean;
}

function summary(observation: FailureObservation): string {
	if (observation.kind === "verification_failure") return "代码验证失败后任务恢复";
	if (observation.kind === "agent_error") return "代理运行错误后任务恢复";
	return `${observation.toolName ?? "未知"} 工具失败后任务恢复`;
}

export class RecoveredFailureTracker {
	private active = false;
	private currentFailure: FailureObservation | undefined;
	private unresolvedFailure: FailureObservation | undefined;
	private lastStopReason: StopReason | undefined;

	start(_now = Date.now()): void {
		this.active = true;
		this.currentFailure = undefined;
		this.lastStopReason = undefined;
	}

	recordTool(event: ObservedToolResult, now = Date.now()): void {
		if (!this.active || event.toolName === "eval_case") return;
		const verification = verificationOutcome(event);
		if (verification === "failed") {
			this.currentFailure ??= {
				kind: "verification_failure",
				toolName: event.toolName,
				detectedAt: now,
				mutationObserved: false,
				verificationPassed: false,
			};
			return;
		}
		if (event.isError) {
			this.currentFailure ??= {
				kind: "tool_error",
				toolName: event.toolName,
				detectedAt: now,
				mutationObserved: false,
				verificationPassed: false,
			};
			return;
		}
		const recovering = this.currentFailure ?? this.unresolvedFailure;
		if (!recovering) return;
		if (mutationPaths(event).length > 0) recovering.mutationObserved = true;
		if (verification === "passed" && recovering.mutationObserved) recovering.verificationPassed = true;
	}

	recordTurn(stopReason: StopReason): void {
		if (this.active) this.lastStopReason = stopReason;
	}

	finish(now = Date.now()): RecoveredFailureSignal | undefined {
		if (!this.active) return undefined;
		this.active = false;
		if (this.unresolvedFailure && now - this.unresolvedFailure.detectedAt > UNRESOLVED_TTL_MS) {
			this.unresolvedFailure = undefined;
		}
		if (this.lastStopReason === "aborted") {
			this.currentFailure = undefined;
			return undefined;
		}
		if (this.lastStopReason !== "stop" && this.lastStopReason !== "length") {
			this.unresolvedFailure = this.currentFailure ?? {
				kind: "agent_error",
				detectedAt: now,
				mutationObserved: false,
				verificationPassed: false,
			};
			this.currentFailure = undefined;
			return undefined;
		}
		const recovered = this.currentFailure ?? this.unresolvedFailure;
		this.currentFailure = undefined;
		if (!recovered) return undefined;
		if (!recovered.mutationObserved || !recovered.verificationPassed) {
			this.unresolvedFailure = recovered.mutationObserved ? recovered : undefined;
			return undefined;
		}
		this.unresolvedFailure = undefined;
		const source = `${recovered.kind}:${recovered.toolName ?? "agent"}`;
		return {
			fingerprint: `${recovered.kind}-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
			kind: recovered.kind,
			...(recovered.toolName ? { toolName: recovered.toolName } : {}),
			summary: summary(recovered),
			detectedAt: new Date(recovered.detectedAt).toISOString(),
			recoveredAt: new Date(now).toISOString(),
		};
	}
}
