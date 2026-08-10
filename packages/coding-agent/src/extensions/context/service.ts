import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../../core/compaction/compaction.ts";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type ReadonlySessionManager,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../../core/session-manager.ts";
import { calculateContextLifecycleMetrics } from "../run-metrics/context-lifecycle.ts";
import { buildRewindReport } from "./report.ts";
import {
	capturePreviewGuard,
	captureWorkspaceSnapshot,
	contextDigest,
	guardsEqual,
	summarizeContext,
} from "./snapshot.ts";
import {
	CONTEXT_ACTIVE_VIEW_TYPE,
	CONTEXT_CHECKPOINT_DELETED_TYPE,
	CONTEXT_CHECKPOINT_TYPE,
	CONTEXT_REWIND_REPORT_TYPE,
	CONTEXT_VIEW_RESTORED_TYPE,
	CONTEXT_VIEW_ROLLBACK_TYPE,
	type ContextActiveView,
	type ContextActiveViewData,
	type ContextCheckpoint,
	type ContextCheckpointData,
	type ContextLifecycleHost,
	type ContextPreviewGuard,
	type ContextRestorePreview,
	type ContextRestoreResult,
	type ContextRewindPreview,
	type ContextRewindReport,
	type ContextWorkspaceSnapshot,
} from "./types.ts";

const MAX_CHECKPOINTS = 20;
const MAX_CHECKPOINT_NAME_CHARACTERS = 80;

export type ContextLifecycleErrorCode =
	| "checkpoint-limit"
	| "checkpoint-not-found"
	| "checkpoint-ambiguous"
	| "checkpoint-not-on-branch"
	| "view-not-found"
	| "conflict"
	| "apply-failed"
	| "restore-failed";

export class ContextLifecycleError extends Error {
	readonly code: ContextLifecycleErrorCode;

	constructor(code: ContextLifecycleErrorCode, message: string) {
		super(message);
		this.name = "ContextLifecycleError";
		this.code = code;
	}
}

export interface ContextLifecycleServiceOptions {
	now?: () => number;
	createId?: () => string;
	captureWorkspace?: (cwd: string) => Promise<ContextWorkspaceSnapshot>;
}

interface CheckpointDeletedData {
	version: 1;
	checkpointId: string;
}

interface ViewStateData {
	version: 1;
	viewId: string;
	reason?: string;
	restoreDurationMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCheckpointData(value: unknown): ContextCheckpointData | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.createdAt !== "string" ||
		(value.parentLeafId !== null && typeof value.parentLeafId !== "string") ||
		typeof value.activeMessageCount !== "number" ||
		typeof value.branchEntryCount !== "number" ||
		typeof value.estimatedInputTokens !== "number" ||
		typeof value.contentDigest !== "string" ||
		typeof value.contentSummary !== "string" ||
		!isRecord(value.workspace)
	) {
		return undefined;
	}
	return value as unknown as ContextCheckpointData;
}

function parseActiveViewData(value: unknown): ContextActiveViewData | undefined {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.metrics)) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.checkpointId !== "string" ||
		typeof value.checkpointEntryId !== "string" ||
		typeof value.originalLeafId !== "string" ||
		typeof value.reportEntryId !== "string" ||
		typeof value.reportDigest !== "string" ||
		typeof value.createdAt !== "string"
	) {
		return undefined;
	}
	return value as unknown as ContextActiveViewData;
}

function deletedCheckpointIds(entries: readonly SessionEntry[]): Set<string> {
	return new Set(
		entries.flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== CONTEXT_CHECKPOINT_DELETED_TYPE) return [];
			const data = entry.data;
			return isRecord(data) && data.version === 1 && typeof data.checkpointId === "string"
				? [data.checkpointId]
				: [];
		}),
	);
}

function completedViewIds(entries: readonly SessionEntry[]): Set<string> {
	return new Set(
		entries.flatMap((entry) => {
			if (
				entry.type !== "custom" ||
				(entry.customType !== CONTEXT_VIEW_RESTORED_TYPE && entry.customType !== CONTEXT_VIEW_ROLLBACK_TYPE)
			) {
				return [];
			}
			const data = entry.data;
			return isRecord(data) && data.version === 1 && typeof data.viewId === "string" ? [data.viewId] : [];
		}),
	);
}

function normalizedName(name: string | undefined): string | undefined {
	const normalized = name
		?.replace(/[\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (!normalized) return undefined;
	return normalized.slice(0, MAX_CHECKPOINT_NAME_CHARACTERS);
}

function activeMessages(sessionManager: ReadonlySessionManager): AgentMessage[] {
	return sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
}

function reportMessage(report: ContextRewindReport, timestamp: number, checkpointId: string): AgentMessage {
	return {
		role: "custom",
		customType: CONTEXT_REWIND_REPORT_TYPE,
		content: report.text,
		display: true,
		details: {
			version: 1,
			checkpointId,
			reportDigest: contextDigest(report.text),
			evidenceIds: report.retainedEvidenceIds,
			userMessageIds: report.retainedUserMessageIds,
		},
		timestamp,
	};
}

function withCacheImpact(report: ContextRewindReport, lines: string[]): ContextRewindReport {
	const closing = "</context-rewind-report>";
	const suffix = ["", "## Prompt cache impact", ...lines.map((line) => `- ${line}`), closing].join("\n");
	return {
		...report,
		text: report.text.endsWith(closing)
			? `${report.text.slice(0, -closing.length).trimEnd()}\n${suffix}`
			: `${report.text}\n${suffix}`,
	};
}

function matchingEntryIds(entries: readonly SessionEntry[]): string[] {
	return entries.map((entry) => entry.id);
}

export class ContextLifecycleService {
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly captureWorkspace: (cwd: string) => Promise<ContextWorkspaceSnapshot>;

	constructor(options: ContextLifecycleServiceOptions = {}) {
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? randomUUID;
		this.captureWorkspace = options.captureWorkspace ?? captureWorkspaceSnapshot;
	}

	listCheckpoints(sessionManager: ReadonlySessionManager): ContextCheckpoint[] {
		const entries = sessionManager.getEntries();
		const deleted = deletedCheckpointIds(entries);
		return entries.flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== CONTEXT_CHECKPOINT_TYPE) return [];
			const data = parseCheckpointData(entry.data);
			return data && data.sessionId === sessionManager.getSessionId() && !deleted.has(data.id)
				? [{ entryId: entry.id, data }]
				: [];
		});
	}

	listRestorableViews(sessionManager: ReadonlySessionManager): ContextActiveView[] {
		const entries = sessionManager.getEntries();
		const completed = completedViewIds(entries);
		const branchIds = new Set(sessionManager.getBranch().map((entry) => entry.id));
		return entries.flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== CONTEXT_ACTIVE_VIEW_TYPE || !branchIds.has(entry.id)) {
				return [];
			}
			const data = parseActiveViewData(entry.data);
			return data && data.sessionId === sessionManager.getSessionId() && !completed.has(data.id)
				? [{ entryId: entry.id, data }]
				: [];
		});
	}

	private resolveCheckpoint(sessionManager: ReadonlySessionManager, identifier?: string): ContextCheckpoint {
		const checkpoints = this.listCheckpoints(sessionManager);
		const query = identifier?.trim();
		if (!query) {
			const branchIds = new Set(sessionManager.getBranch().map((entry) => entry.id));
			const latest = [...checkpoints].reverse().find((checkpoint) => branchIds.has(checkpoint.entryId));
			if (latest) return latest;
			throw new ContextLifecycleError("checkpoint-not-found", "No checkpoint exists on the active session branch");
		}
		const exact = checkpoints.filter(
			(checkpoint) =>
				checkpoint.data.id === query ||
				checkpoint.entryId === query ||
				checkpoint.data.name?.toLowerCase() === query.toLowerCase(),
		);
		const matches =
			exact.length > 0
				? exact
				: checkpoints.filter(
						(checkpoint) => checkpoint.data.id.startsWith(query) || checkpoint.entryId.startsWith(query),
					);
		if (matches.length === 0) {
			throw new ContextLifecycleError("checkpoint-not-found", `Checkpoint not found: ${query}`);
		}
		if (matches.length > 1) {
			throw new ContextLifecycleError("checkpoint-ambiguous", `Checkpoint identifier is ambiguous: ${query}`);
		}
		return matches[0];
	}

	private resolveView(sessionManager: ReadonlySessionManager, identifier?: string): ContextActiveView {
		const views = this.listRestorableViews(sessionManager);
		const query = identifier?.trim();
		if (!query) {
			const latest = views[views.length - 1];
			if (latest) return latest;
			throw new ContextLifecycleError("view-not-found", "No active rewind view can be restored");
		}
		const matches = views.filter(
			(view) =>
				view.data.id === query ||
				view.entryId === query ||
				view.data.id.startsWith(query) ||
				view.entryId.startsWith(query),
		);
		if (matches.length !== 1) {
			throw new ContextLifecycleError(
				"view-not-found",
				matches.length === 0 ? `Rewind view not found: ${query}` : `Rewind view identifier is ambiguous: ${query}`,
			);
		}
		return matches[0];
	}

	async createCheckpoint(host: ContextLifecycleHost, name?: string): Promise<ContextCheckpoint> {
		if (this.listCheckpoints(host.sessionManager).length >= MAX_CHECKPOINTS) {
			throw new ContextLifecycleError(
				"checkpoint-limit",
				`This session already has the maximum of ${MAX_CHECKPOINTS} checkpoints; delete one before creating another`,
			);
		}
		const messages = activeMessages(host.sessionManager);
		const workspace = await this.captureWorkspace(host.cwd);
		const data: ContextCheckpointData = {
			version: 1,
			id: this.createId(),
			name: normalizedName(name),
			sessionId: host.sessionManager.getSessionId(),
			createdAt: new Date(this.now()).toISOString(),
			parentLeafId: host.sessionManager.getLeafId(),
			gitBranch: workspace.branch,
			workspace,
			activeMessageCount: messages.length,
			branchEntryCount: host.sessionManager.getBranch().length,
			estimatedInputTokens: messages.reduce((sum, message) => sum + estimateTokens(message), 0),
			contentDigest: contextDigest(messages),
			contentSummary: summarizeContext(messages),
		};
		const entryId = host.appendEntry(CONTEXT_CHECKPOINT_TYPE, data);
		return { entryId, data };
	}

	deleteCheckpoint(host: ContextLifecycleHost, identifier: string): ContextCheckpoint {
		const checkpoint = this.resolveCheckpoint(host.sessionManager, identifier);
		const data: CheckpointDeletedData = { version: 1, checkpointId: checkpoint.data.id };
		host.appendEntry(CONTEXT_CHECKPOINT_DELETED_TYPE, data);
		return checkpoint;
	}

	async preview(host: ContextLifecycleHost, identifier?: string): Promise<ContextRewindPreview> {
		const checkpoint = this.resolveCheckpoint(host.sessionManager, identifier);
		const branch = host.sessionManager.getBranch();
		const checkpointIndex = branch.findIndex((entry) => entry.id === checkpoint.entryId);
		if (checkpointIndex < 0) {
			throw new ContextLifecycleError(
				"checkpoint-not-on-branch",
				`Checkpoint ${checkpoint.data.name ?? checkpoint.data.id} is not on the active branch`,
			);
		}
		const originalLeafId = host.sessionManager.getLeafId();
		if (!originalLeafId) {
			throw new ContextLifecycleError("checkpoint-not-on-branch", "The active branch has no recoverable leaf");
		}

		const startedAt = performance.now();
		const runtime = host.getRuntimeSnapshot();
		const baseReport = buildRewindReport(branch.slice(checkpointIndex + 1), runtime, checkpoint.data.id);
		let report = baseReport;
		const before = activeMessages(host.sessionManager);
		const checkpointContext = buildSessionContext(host.sessionManager.getEntries(), checkpoint.entryId).messages;
		let message = reportMessage(report, this.now(), checkpoint.data.id);
		let metrics = calculateContextLifecycleMetrics({
			before,
			after: [...checkpointContext, message],
			deterministicEvidenceIds: report.evidence.map((item) => item.id),
			retainedEvidenceIds: report.retainedEvidenceIds,
			userMessageIds: report.userMessageIds,
			retainedUserMessageIds: report.retainedUserMessageIds,
			reportGenerationMs: 0,
			recoverable: host.sessionManager.getEntry(originalLeafId) !== undefined,
		});
		for (let iteration = 0; iteration < 2; iteration++) {
			report = withCacheImpact(baseReport, [
				`${metrics.promptCacheReusablePrefixMessages} exact messages / ${metrics.promptCacheReusablePrefixTokens} estimated tokens remain reusable`,
				`${metrics.promptCacheInvalidatedSuffixTokens} estimated suffix tokens are invalidated`,
				"messages before the checkpoint are not rewritten",
			]);
			message = reportMessage(report, this.now(), checkpoint.data.id);
			metrics = calculateContextLifecycleMetrics({
				before,
				after: [...checkpointContext, message],
				deterministicEvidenceIds: report.evidence.map((item) => item.id),
				retainedEvidenceIds: report.retainedEvidenceIds,
				userMessageIds: report.userMessageIds,
				retainedUserMessageIds: report.retainedUserMessageIds,
				reportGenerationMs: performance.now() - startedAt,
				recoverable: host.sessionManager.getEntry(originalLeafId) !== undefined,
			});
		}
		const workspace = await this.captureWorkspace(host.cwd);
		const guard = await capturePreviewGuard(host.sessionManager, runtime, workspace);
		return {
			version: 1,
			checkpoint,
			createdAt: new Date(this.now()).toISOString(),
			originalLeafId,
			report,
			reportMessage: message,
			metrics,
			guard,
		};
	}

	private async currentGuard(host: ContextLifecycleHost): Promise<ContextPreviewGuard> {
		return capturePreviewGuard(host.sessionManager, host.getRuntimeSnapshot(), await this.captureWorkspace(host.cwd));
	}

	async assertPreviewCurrent(host: ContextLifecycleHost, expected: ContextPreviewGuard): Promise<void> {
		const actual = await this.currentGuard(host);
		if (!guardsEqual(expected, actual)) {
			throw new ContextLifecycleError(
				"conflict",
				"Session, workspace, model, tools, or safety state changed after the preview; generate a new preview",
			);
		}
	}

	private validatePersistentMirror(sessionManager: ReadonlySessionManager): void {
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) return;
		const diskEntries = loadEntriesFromFile(sessionFile).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
		const memoryEntries = sessionManager.getEntries();
		if (
			diskEntries.length !== memoryEntries.length ||
			matchingEntryIds(diskEntries).some((id, index) => id !== memoryEntries[index]?.id)
		) {
			throw new ContextLifecycleError(
				"conflict",
				"Another process appended to the session during context activation",
			);
		}
	}

	private async rollback(
		host: ContextLifecycleHost,
		targetLeafId: string,
		viewId: string,
		reason: string,
	): Promise<void> {
		const result = await host.navigateTree(targetLeafId);
		if (result.cancelled) throw new Error("Context rollback navigation was cancelled");
		const data: ViewStateData = { version: 1, viewId, reason };
		host.appendEntry(CONTEXT_VIEW_ROLLBACK_TYPE, data);
	}

	async apply(host: ContextLifecycleHost, preview: ContextRewindPreview): Promise<ContextActiveView> {
		await this.assertPreviewCurrent(host, preview.guard);
		const viewId = this.createId();
		let navigationStarted = false;
		try {
			const navigation = await host.navigateTree(preview.checkpoint.entryId);
			if (navigation.cancelled) throw new Error("Checkpoint navigation was cancelled");
			navigationStarted = true;
			const reportEntryId = host.appendReport(preview.report.text, {
				version: 1,
				checkpointId: preview.checkpoint.data.id,
				reportDigest: contextDigest(preview.report.text),
				evidenceIds: preview.report.retainedEvidenceIds,
				userMessageIds: preview.report.retainedUserMessageIds,
				metrics: preview.metrics,
			});
			const data: ContextActiveViewData = {
				version: 1,
				id: viewId,
				sessionId: host.sessionManager.getSessionId(),
				checkpointId: preview.checkpoint.data.id,
				checkpointEntryId: preview.checkpoint.entryId,
				originalLeafId: preview.originalLeafId,
				reportEntryId,
				reportDigest: contextDigest(preview.report.text),
				createdAt: new Date(this.now()).toISOString(),
				metrics: preview.metrics,
			};
			const entryId = host.appendEntry(CONTEXT_ACTIVE_VIEW_TYPE, data);
			this.validatePersistentMirror(host.sessionManager);
			if (host.sessionManager.getLeafId() !== entryId)
				throw new Error("Active context view marker was not selected");
			return { entryId, data };
		} catch (error) {
			if (navigationStarted) {
				try {
					await this.rollback(
						host,
						preview.originalLeafId,
						viewId,
						error instanceof Error ? error.message : String(error),
					);
				} catch (rollbackError) {
					throw new ContextLifecycleError(
						"apply-failed",
						`Rewind failed and persistent rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			if (error instanceof ContextLifecycleError) throw error;
			throw new ContextLifecycleError(
				"apply-failed",
				`Rewind failed; the original active context was restored: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async previewRestore(host: ContextLifecycleHost, identifier?: string): Promise<ContextRestorePreview> {
		return {
			view: this.resolveView(host.sessionManager, identifier),
			guard: await this.currentGuard(host),
		};
	}

	async restore(host: ContextLifecycleHost, preview: ContextRestorePreview): Promise<ContextRestoreResult> {
		await this.assertPreviewCurrent(host, preview.guard);
		const restoreStartedAt = performance.now();
		const startingLeafId = host.sessionManager.getLeafId();
		if (!startingLeafId) throw new ContextLifecycleError("restore-failed", "Current context has no rollback leaf");
		let navigationStarted = false;
		try {
			const navigation = await host.navigateTree(preview.view.data.originalLeafId);
			if (navigation.cancelled) throw new Error("Full-context navigation was cancelled");
			navigationStarted = true;
			const restoreDurationMs = performance.now() - restoreStartedAt;
			const marker: ViewStateData = { version: 1, viewId: preview.view.data.id, restoreDurationMs };
			host.appendEntry(CONTEXT_VIEW_RESTORED_TYPE, marker);
			this.validatePersistentMirror(host.sessionManager);
			return {
				view: preview.view,
				metrics: { ...preview.view.data.metrics, restoreDurationMs },
			};
		} catch (error) {
			if (navigationStarted) {
				try {
					await this.rollback(
						host,
						startingLeafId,
						preview.view.data.id,
						error instanceof Error ? error.message : String(error),
					);
				} catch (rollbackError) {
					throw new ContextLifecycleError(
						"restore-failed",
						`Restore failed and the rewind view rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
			if (error instanceof ContextLifecycleError) throw error;
			throw new ContextLifecycleError(
				"restore-failed",
				`Full-context restore failed; the rewind view was restored: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	getSavings(sessionManager: ReadonlySessionManager): {
		views: number;
		estimatedTokensRemoved: number;
		averageReductionPercent: number;
		evidenceRetentionPercent: number;
		userMessageRetentionPercent: number;
	} {
		const views = sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== CONTEXT_ACTIVE_VIEW_TYPE) return [];
			const data = parseActiveViewData(entry.data);
			return data ? [data] : [];
		});
		const sum = (selector: (view: ContextActiveViewData) => number): number =>
			views.reduce((total, view) => total + selector(view), 0);
		return {
			views: views.length,
			estimatedTokensRemoved: sum((view) => view.metrics.estimatedTokensRemoved),
			averageReductionPercent:
				views.length === 0 ? 0 : sum((view) => view.metrics.tokenReductionPercent) / views.length,
			evidenceRetentionPercent:
				views.length === 0 ? 100 : sum((view) => view.metrics.deterministicEvidenceRetentionPercent) / views.length,
			userMessageRetentionPercent:
				views.length === 0 ? 100 : sum((view) => view.metrics.userMessageRetentionPercent) / views.length,
		};
	}
}
