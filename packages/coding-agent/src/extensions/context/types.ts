import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionMode } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import type { ToolApprovalMode, ToolApprovalSetting } from "../../core/settings-manager.ts";
import type { ContextLifecycleMetrics } from "../run-metrics/context-lifecycle.ts";

export const CONTEXT_CHECKPOINT_TYPE = "pi.context.checkpoint.v1";
export const CONTEXT_CHECKPOINT_DELETED_TYPE = "pi.context.checkpoint-deleted.v1";
export const CONTEXT_REWIND_REPORT_TYPE = "pi.context.rewind-report.v1";
export const CONTEXT_ACTIVE_VIEW_TYPE = "pi.context.active-view.v1";
export const CONTEXT_VIEW_RESTORED_TYPE = "pi.context.view-restored.v1";
export const CONTEXT_VIEW_ROLLBACK_TYPE = "pi.context.view-rollback.v1";

export interface ContextWorkspaceSnapshot {
	available: boolean;
	branch?: string;
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
	paths: string[];
	statusDigest: string;
	summary: string;
}

export interface ContextRuntimeSnapshot {
	model?: { provider: string; id: string };
	activeTools: string[];
	mode: ExtensionMode;
	projectTrusted: boolean;
	approval?: {
		mode: ToolApprovalMode;
		policies: Readonly<Record<string, ToolApprovalSetting>>;
	};
}

export interface ContextCheckpointData {
	version: 1;
	id: string;
	name?: string;
	sessionId: string;
	createdAt: string;
	parentLeafId: string | null;
	gitBranch?: string;
	workspace: Omit<ContextWorkspaceSnapshot, "statusDigest"> & { statusDigest: string };
	activeMessageCount: number;
	branchEntryCount: number;
	estimatedInputTokens: number;
	contentDigest: string;
	contentSummary: string;
}

export interface ContextCheckpoint {
	entryId: string;
	data: ContextCheckpointData;
}

export type ContextEvidenceKind =
	| "user-requirement"
	| "tool-call"
	| "tool-result"
	| "context-summary"
	| "file-line"
	| "file-change"
	| "test-diagnostic"
	| "failed-attempt"
	| "todo"
	| "user-decision"
	| "approval"
	| "untrusted";

export interface ContextEvidence {
	id: string;
	kind: ContextEvidenceKind;
	digest: string;
	summary: string;
}

export interface ContextRewindReport {
	text: string;
	evidence: ContextEvidence[];
	retainedEvidenceIds: string[];
	userMessageIds: string[];
	retainedUserMessageIds: string[];
}

export interface ContextStorageGuard {
	path: string;
	size: number;
	modifiedMs: number;
	sha256: string;
}

export interface ContextPreviewGuard {
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	branchDigest: string;
	storage?: ContextStorageGuard;
	workspaceDigest: string;
	runtimeDigest: string;
}

export interface ContextRewindPreview {
	version: 1;
	checkpoint: ContextCheckpoint;
	createdAt: string;
	originalLeafId: string;
	report: ContextRewindReport;
	reportMessage: AgentMessage;
	metrics: ContextLifecycleMetrics;
	guard: ContextPreviewGuard;
}

export interface ContextActiveViewData {
	version: 1;
	id: string;
	sessionId: string;
	checkpointId: string;
	checkpointEntryId: string;
	originalLeafId: string;
	reportEntryId: string;
	reportDigest: string;
	createdAt: string;
	metrics: ContextLifecycleMetrics;
}

export interface ContextActiveView {
	entryId: string;
	data: ContextActiveViewData;
}

export interface ContextRestoreResult {
	view: ContextActiveView;
	metrics: ContextLifecycleMetrics & { restoreDurationMs: number };
}

export interface ContextRestorePreview {
	view: ContextActiveView;
	guard: ContextPreviewGuard;
}

export interface ContextLifecycleHost {
	readonly cwd: string;
	readonly sessionManager: ReadonlySessionManager;
	getRuntimeSnapshot(): ContextRuntimeSnapshot;
	appendEntry(customType: string, data: unknown): string;
	appendReport(content: string, details: unknown): string;
	navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
}
