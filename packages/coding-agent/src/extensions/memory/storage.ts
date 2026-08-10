import { createHash, randomUUID } from "node:crypto";
import { getMemoryPath } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { LockedJsonMemoryBackend, type MemoryBackend } from "./backend.ts";
import { captureFileEvidence, validateFileEvidence } from "./evidence.ts";
import { rankMemoryRecords } from "./recall.ts";
import { containsAuthorityDirective, containsSensitiveCredential } from "./security.ts";
import {
	MAX_MEMORY_CONTENT_LENGTH,
	MAX_MEMORY_FIELD_LENGTH,
	MAX_MEMORY_RECALL_QUERY_LENGTH,
	MAX_MEMORY_RECORDS,
	MAX_RECALLED_MEMORIES,
	type MemoryAuditEvent,
	type MemoryEvidence,
	type MemoryFeedbackOutcome,
	type MemoryRecallHit,
	type MemoryRecallOptions,
	type MemoryRecallResult,
	type MemoryRecord,
	type MemoryScope,
	type MemoryStoreData,
	type ProjectMemoryScope,
	type WriteMemoryInput,
} from "./types.ts";

function normalizeText(value: string, label: string, maxLength: number): string {
	const normalized = stripAnsi(value)
		.replace(/[\p{Cc}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (!normalized) throw new Error(`${label}不能为空`);
	if (normalized.length > maxLength) throw new Error(`${label}最多 ${maxLength} 个字符`);
	return normalized;
}

function canonical(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function sameProject(left: ProjectMemoryScope, right: ProjectMemoryScope): boolean {
	const leftRoot = process.platform === "win32" ? left.projectRoot.toLocaleLowerCase() : left.projectRoot;
	const rightRoot = process.platform === "win32" ? right.projectRoot.toLocaleLowerCase() : right.projectRoot;
	return left.projectId === right.projectId && leftRoot === rightRoot;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
	if (left.type !== right.type) return false;
	return left.type === "global" || sameProject(left, right as ProjectMemoryScope);
}

function isVisible(record: MemoryRecord, projectScope: ProjectMemoryScope): boolean {
	return record.scope.type === "global" || sameProject(record.scope, projectScope);
}

function sameClaim(left: MemoryRecord, right: Pick<MemoryRecord, "kind" | "claim" | "scope">): boolean {
	return (
		left.kind === right.kind &&
		sameScope(left.scope, right.scope) &&
		canonical(left.claim.subject) === canonical(right.claim.subject) &&
		canonical(left.claim.predicate) === canonical(right.claim.predicate)
	);
}

function addEvent(
	store: MemoryStoreData,
	type: MemoryAuditEvent["type"],
	recordId: string,
	now: Date,
	detail?: string,
): void {
	store.events.push({
		id: `me_${randomUUID().replaceAll("-", "")}`,
		type,
		recordId,
		timestamp: now.toISOString(),
		...(detail ? { detail: detail.slice(0, 120) } : {}),
	});
}

function scopeForInput(input: WriteMemoryInput, projectScope: ProjectMemoryScope): MemoryScope {
	return input.kind === "user" ? { type: "global" } : projectScope;
}

function contentHash(input: WriteMemoryInput, scope: MemoryScope, evidence: readonly MemoryEvidence[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				kind: input.kind,
				claim: input.claim,
				content: input.content,
				scope: scope.type === "global" ? scope : { type: scope.type, projectId: scope.projectId },
				evidence: evidence.map((item) =>
					item.type === "file"
						? { type: item.type, path: item.path, mode: item.mode, digest: item.digest }
						: { type: item.type },
				),
			}),
		)
		.digest("hex");
}

async function evidenceStaleReason(
	record: MemoryRecord,
	projectScope: ProjectMemoryScope,
): Promise<MemoryRecord["staleReason"]> {
	if (record.scope.type === "global" || !sameProject(record.scope, projectScope)) return undefined;
	return validateFileEvidence(
		record.evidence.filter((item) => item.type === "file"),
		projectScope,
	);
}

function markStale(
	store: MemoryStoreData,
	record: MemoryRecord,
	reason: NonNullable<MemoryRecord["staleReason"]>,
	now: Date,
): void {
	record.status = "stale";
	record.staleReason = reason;
	record.staleAt = now.toISOString();
	record.validTo = now.toISOString();
	record.updatedAt = now.toISOString();
	record.revision += 1;
	addEvent(store, "stale", record.id, now, reason);
}

function supersedeRecord(store: MemoryStoreData, oldRecord: MemoryRecord, replacement: MemoryRecord, now: Date): void {
	oldRecord.status = "superseded";
	oldRecord.supersededBy = replacement.id;
	oldRecord.validTo = now.toISOString();
	oldRecord.updatedAt = now.toISOString();
	oldRecord.revision += 1;
	replacement.supersedes.push(oldRecord.id);
	addEvent(store, "superseded", oldRecord.id, now, replacement.id);
}

function findRecord(store: MemoryStoreData, id: string, projectScope: ProjectMemoryScope): MemoryRecord {
	const record = store.records.find((candidate) => candidate.id === id && isVisible(candidate, projectScope));
	if (!record) throw new Error(`找不到记忆 ${id}`);
	return record;
}

function removeRecords(store: MemoryStoreData, records: readonly MemoryRecord[], now: Date): void {
	const removedIds = new Set(records.map((record) => record.id));
	for (const record of records) addEvent(store, "forgotten", record.id, now);
	store.records = store.records.filter((record) => !removedIds.has(record.id));
	for (const record of store.records) {
		record.conflictWith = record.conflictWith.filter((id) => !removedIds.has(id));
		record.supersedes = record.supersedes.filter((id) => !removedIds.has(id));
		if (record.supersededBy && removedIds.has(record.supersededBy)) delete record.supersededBy;
	}
	store.revision += 1;
}

function normalizedWriteInput(input: WriteMemoryInput): WriteMemoryInput {
	const evidence = input.evidence.map((item) => ({
		path: item.path.trim(),
		...(item.quote?.trim() ? { quote: item.quote.trim() } : {}),
	}));
	return {
		source: input.source,
		kind: input.kind,
		claim: {
			subject: normalizeText(input.claim.subject, "记忆主体", MAX_MEMORY_FIELD_LENGTH),
			predicate: normalizeText(input.claim.predicate, "记忆属性", MAX_MEMORY_FIELD_LENGTH),
			value: normalizeText(input.claim.value, "记忆值", MAX_MEMORY_CONTENT_LENGTH),
		},
		content: normalizeText(input.content, "记忆内容", MAX_MEMORY_CONTENT_LENGTH),
		evidence: evidence.filter((item) => item.path),
		importance: input.importance ?? (input.kind === "user" ? "core" : "normal"),
		confidence: Math.max(0, Math.min(1, input.confidence ?? (input.source === "user" ? 1 : 0.8))),
	};
}

export interface MemoryStoreSnapshot {
	revision: number;
	records: MemoryRecord[];
	eventCount: number;
}

interface ApprovalOutcome {
	record: MemoryRecord;
	error?: string;
}

export class MemoryStore {
	private readonly backend: MemoryBackend;
	private readonly now: () => Date;

	constructor(
		storage: AuthStorageBackend = new FileAuthStorageBackend(getMemoryPath()),
		now: () => Date = () => new Date(),
	) {
		this.backend = new LockedJsonMemoryBackend(storage);
		this.now = now;
	}

	private async write(input: WriteMemoryInput, projectScope: ProjectMemoryScope): Promise<MemoryRecord> {
		const normalized = normalizedWriteInput(input);
		const protectedText = [
			normalized.claim.subject,
			normalized.claim.predicate,
			normalized.claim.value,
			normalized.content,
			...normalized.evidence.map((item) => item.quote ?? ""),
		].join("\n");
		if (containsSensitiveCredential(protectedText)) throw new Error("记忆中疑似包含敏感凭据，已拒绝保存");
		if (containsAuthorityDirective(protectedText)) throw new Error("记忆不能修改工具权限、审批或安全策略");
		if (normalized.kind === "user" && normalized.evidence.length > 0) {
			throw new Error("用户偏好由用户确认，不绑定项目文件");
		}
		const scope = scopeForInput(normalized, projectScope);
		const evidence: MemoryEvidence[] =
			scope.type === "project" ? await captureFileEvidence(normalized.evidence, projectScope, this.now) : [];
		const digest = contentHash(normalized, scope, evidence);
		return this.backend.transact(async (store) => {
			const sameValue = store.records.find(
				(record) =>
					(record.status === "active" || record.status === "candidate") &&
					record.kind === normalized.kind &&
					sameScope(record.scope, scope) &&
					canonical(record.claim.subject) === canonical(normalized.claim.subject) &&
					canonical(record.claim.predicate) === canonical(normalized.claim.predicate) &&
					canonical(record.claim.value) === canonical(normalized.claim.value),
			);
			if (sameValue) {
				if (normalized.source === "user" && sameValue.status === "candidate") {
					const timestamp = this.now();
					const conflicts = store.records.filter(
						(record) => record.id !== sameValue.id && record.status === "active" && sameClaim(record, sameValue),
					);
					sameValue.evidence = evidence;
					sameValue.contentHash = digest;
					sameValue.status = "active";
					sameValue.source = "user";
					sameValue.approvedAt = timestamp.toISOString();
					sameValue.updatedAt = timestamp.toISOString();
					sameValue.revision += 1;
					sameValue.evidence.push({ type: "user_confirmation", capturedAt: timestamp.toISOString() });
					for (const conflict of conflicts) supersedeRecord(store, conflict, sameValue, timestamp);
					addEvent(store, "activated", sameValue.id, timestamp, "explicit_user_confirmation");
					store.revision += 1;
					return { result: structuredClone(sameValue), changed: true };
				}
				return { result: structuredClone(sameValue) };
			}
			const exactDuplicate = store.records.find(
				(record) =>
					record.contentHash === digest &&
					sameScope(record.scope, scope) &&
					(record.status === "candidate" || record.status === "active"),
			);
			if (exactDuplicate) return { result: structuredClone(exactDuplicate) };
			if (store.records.length >= MAX_MEMORY_RECORDS) throw new Error(`记忆已达到 ${MAX_MEMORY_RECORDS} 条上限`);
			const timestamp = this.now();
			const conflicts = store.records.filter(
				(record) =>
					record.status === "active" &&
					sameClaim(record, { kind: normalized.kind, claim: normalized.claim, scope }),
			);
			const active = normalized.source === "user";
			const record: MemoryRecord = {
				id: `m_${randomUUID().replaceAll("-", "")}`,
				kind: normalized.kind,
				claim: normalized.claim,
				content: normalized.content,
				contentHash: digest,
				status: active ? "active" : "candidate",
				source: normalized.source,
				importance: normalized.importance ?? "normal",
				confidence: normalized.confidence ?? 0.8,
				scope,
				evidence,
				conflictWith: conflicts.map((item) => item.id),
				supersedes: [],
				validFrom: timestamp.toISOString(),
				createdAt: timestamp.toISOString(),
				updatedAt: timestamp.toISOString(),
				...(active ? { approvedAt: timestamp.toISOString() } : {}),
				usage: { recallCount: 0, adoptedCount: 0, helpfulCount: 0, harmfulCount: 0 },
				revision: 1,
			};
			if (active) {
				record.evidence.push({ type: "user_confirmation", capturedAt: timestamp.toISOString() });
				for (const conflict of conflicts) supersedeRecord(store, conflict, record, timestamp);
			}
			store.records.push(record);
			addEvent(store, active ? "activated" : "proposed", record.id, timestamp, normalized.source);
			store.revision += 1;
			return { result: structuredClone(record), changed: true };
		});
	}

	remember(input: Omit<WriteMemoryInput, "source">, projectScope: ProjectMemoryScope): Promise<MemoryRecord> {
		return this.write({ ...input, source: "user" }, projectScope);
	}

	propose(input: Omit<WriteMemoryInput, "source">, projectScope: ProjectMemoryScope): Promise<MemoryRecord> {
		return this.write({ ...input, source: "agent" }, projectScope);
	}

	async approve(id: string, expectedRevision: number, projectScope: ProjectMemoryScope): Promise<MemoryRecord> {
		const outcome = await this.backend.transact<ApprovalOutcome>(async (store) => {
			const record = findRecord(store, id, projectScope);
			if (record.revision !== expectedRevision)
				throw new Error(`记忆记录已变化，当前 revision 为 ${record.revision}`);
			if (record.status !== "candidate") throw new Error(`只有候选记忆可以批准，当前状态为 ${record.status}`);
			const staleReason = await evidenceStaleReason(record, projectScope);
			if (staleReason) {
				markStale(store, record, staleReason, this.now());
				store.revision += 1;
				return {
					result: { record: structuredClone(record), error: "候选证据已经变化，请重新提出记忆" },
					changed: true,
				};
			}
			const timestamp = this.now();
			const conflicts = store.records.filter(
				(other) => other.id !== record.id && other.status === "active" && sameClaim(other, record),
			);
			for (const conflict of conflicts) supersedeRecord(store, conflict, record, timestamp);
			record.status = "active";
			record.approvedAt = timestamp.toISOString();
			record.updatedAt = timestamp.toISOString();
			record.revision += 1;
			record.evidence.push({ type: "user_confirmation", capturedAt: timestamp.toISOString() });
			addEvent(store, "activated", record.id, timestamp, "approved_candidate");
			store.revision += 1;
			return { result: { record: structuredClone(record) }, changed: true };
		});
		if (outcome.error) throw new Error(outcome.error);
		return outcome.record;
	}

	async reject(id: string, expectedRevision: number, projectScope: ProjectMemoryScope): Promise<MemoryRecord> {
		return this.backend.transact(async (store) => {
			const record = findRecord(store, id, projectScope);
			if (record.revision !== expectedRevision)
				throw new Error(`记忆记录已变化，当前 revision 为 ${record.revision}`);
			if (record.status !== "candidate") throw new Error(`只有候选记忆可以拒绝，当前状态为 ${record.status}`);
			const timestamp = this.now();
			record.status = "rejected";
			record.rejectedAt = timestamp.toISOString();
			record.validTo = timestamp.toISOString();
			record.updatedAt = timestamp.toISOString();
			record.revision += 1;
			addEvent(store, "rejected", record.id, timestamp);
			store.revision += 1;
			return { result: structuredClone(record), changed: true };
		});
	}

	async forget(id: string, expectedRevision: number, projectScope: ProjectMemoryScope): Promise<void> {
		await this.backend.transact(async (store) => {
			const record = findRecord(store, id, projectScope);
			if (record.revision !== expectedRevision)
				throw new Error(`记忆记录已变化，当前 revision 为 ${record.revision}`);
			removeRecords(store, [record], this.now());
			return { result: undefined, changed: true };
		});
	}

	async forgetMany(ids: readonly string[], projectScope: ProjectMemoryScope): Promise<MemoryRecord[]> {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) throw new Error("至少需要一个记忆 ID");
		return this.backend.transact(async (store) => {
			const records = uniqueIds.map((id) => findRecord(store, id, projectScope));
			removeRecords(store, records, this.now());
			return { result: records.map((record) => structuredClone(record)), changed: true };
		});
	}

	async list(projectScope: ProjectMemoryScope): Promise<MemoryStoreSnapshot> {
		return this.backend.transact(async (store) => {
			let changed = false;
			for (const record of store.records) {
				if (record.status !== "active" || !isVisible(record, projectScope)) continue;
				const staleReason = await evidenceStaleReason(record, projectScope);
				if (!staleReason) continue;
				markStale(store, record, staleReason, this.now());
				changed = true;
			}
			if (changed) store.revision += 1;
			const records = store.records
				.filter((record) => isVisible(record, projectScope))
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
				.map((record) => structuredClone(record));
			return {
				result: { revision: store.revision, records, eventCount: store.events.length },
				changed,
			};
		});
	}

	async recall(
		query: string,
		projectScope: ProjectMemoryScope,
		options: MemoryRecallOptions = {},
	): Promise<MemoryRecallResult> {
		const normalizedQuery = normalizeText(query, "召回查询", MAX_MEMORY_RECALL_QUERY_LENGTH);
		const limit = Math.max(1, Math.min(options.limit ?? MAX_RECALLED_MEMORIES, MAX_RECALLED_MEMORIES));
		return this.backend.transact(async (store) => {
			const visible = store.records.filter(
				(record) => record.status === "active" && isVisible(record, projectScope),
			);
			const ranked = rankMemoryRecords(normalizedQuery, visible);
			const core = options.includeCore
				? visible
						.filter((record) => record.kind === "user" && record.importance === "core")
						.sort(
							(left, right) =>
								right.usage.helpfulCount -
									right.usage.harmfulCount -
									(left.usage.helpfulCount - left.usage.harmfulCount) ||
								right.updatedAt.localeCompare(left.updatedAt),
						)
						.slice(0, 3)
						.map<MemoryRecallHit>((record) => ({ record, score: 100, reasons: ["core"] }))
				: [];
			const candidates = [
				...core,
				...ranked.filter(
					(hit) => hit.record.kind !== "user" && !core.some((item) => item.record.id === hit.record.id),
				),
			];
			const hits: MemoryRecallHit[] = [];
			const staleRecords: MemoryRecord[] = [];
			const timestamp = this.now();
			for (const hit of candidates) {
				const staleReason = await evidenceStaleReason(hit.record, projectScope);
				if (staleReason) {
					markStale(store, hit.record, staleReason, timestamp);
					staleRecords.push(structuredClone(hit.record));
					continue;
				}
				hit.record.usage.recallCount += 1;
				hit.record.usage.lastRecalledAt = timestamp.toISOString();
				hit.record.revision += 1;
				addEvent(store, "recalled", hit.record.id, timestamp, hit.reasons.join(","));
				hits.push({ ...hit, record: structuredClone(hit.record) });
				if (hits.length >= limit) break;
			}
			const changed = hits.length > 0 || staleRecords.length > 0;
			if (changed) store.revision += 1;
			return { result: { hits, staleRecords }, changed };
		});
	}

	async feedback(
		ids: readonly string[],
		outcome: MemoryFeedbackOutcome,
		projectScope: ProjectMemoryScope,
	): Promise<MemoryRecord[]> {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) throw new Error("至少需要一个记忆 ID");
		return this.backend.transact(async (store) => {
			const timestamp = this.now();
			const records = uniqueIds.map((id) => findRecord(store, id, projectScope));
			for (const record of records) {
				if (record.status !== "active") throw new Error(`记忆 ${record.id} 当前不可反馈`);
				if (outcome !== "neutral") record.usage.adoptedCount += 1;
				if (outcome === "helpful") record.usage.helpfulCount += 1;
				if (outcome === "harmful") record.usage.harmfulCount += 1;
				record.usage.lastFeedbackAt = timestamp.toISOString();
				record.updatedAt = timestamp.toISOString();
				record.revision += 1;
				addEvent(store, "feedback", record.id, timestamp, outcome);
			}
			store.revision += 1;
			return { result: records.map((record) => structuredClone(record)), changed: true };
		});
	}
}
