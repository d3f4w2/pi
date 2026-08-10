import { Compile } from "typebox/compile";
import type { AuthStorageBackend } from "../../core/auth-storage.ts";
import {
	MAX_MEMORY_EVENTS,
	MEMORY_SCHEMA_VERSION,
	type MemoryEvidence,
	type MemoryKind,
	type MemoryRecord,
	type MemoryScope,
	type MemoryStatus,
	type MemoryStoreData,
	MemoryStoreDataSchema,
} from "./types.ts";

const memoryStoreValidator = Compile(MemoryStoreDataSchema);

export interface MemoryBackendMutation<T> {
	result: T;
	changed?: boolean;
}

export interface MemoryBackend {
	transact<T>(mutate: (store: MemoryStoreData) => Promise<MemoryBackendMutation<T>>): Promise<T>;
}

function emptyStore(): MemoryStoreData {
	return { schemaVersion: MEMORY_SCHEMA_VERSION, revision: 0, records: [], events: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function migrateLegacyScope(value: unknown): MemoryScope | undefined {
	if (!isObject(value)) return undefined;
	if (value.type === "global") return { type: "global" };
	if (
		value.type === "project" &&
		typeof value.projectId === "string" &&
		typeof value.projectRoot === "string" &&
		typeof value.branch === "string"
	) {
		return {
			type: "project",
			projectId: value.projectId,
			projectRoot: value.projectRoot,
			branch: value.branch,
		};
	}
	return undefined;
}

function migrateLegacyEvidence(value: unknown): MemoryEvidence[] {
	if (!Array.isArray(value)) return [];
	const evidence: MemoryEvidence[] = [];
	for (const item of value) {
		if (!isObject(item)) continue;
		if (item.type === "user_confirmation" && typeof item.capturedAt === "string") {
			evidence.push({ type: "user_confirmation", capturedAt: item.capturedAt });
			continue;
		}
		if (
			item.type === "file" &&
			typeof item.path === "string" &&
			typeof item.digest === "string" &&
			typeof item.size === "number" &&
			typeof item.capturedAt === "string"
		) {
			evidence.push({
				type: "file",
				path: item.path,
				mode: "file",
				digest: item.digest,
				size: item.size,
				capturedAt: item.capturedAt,
			});
		}
	}
	return evidence;
}

function migrateLegacyRecord(value: unknown): MemoryRecord | undefined {
	if (!isObject(value)) return undefined;
	const scope = migrateLegacyScope(value.scope);
	const id = asString(value.id);
	const key = asString(value.key);
	const content = asString(value.content);
	const createdAt = asString(value.createdAt);
	const updatedAt = asString(value.updatedAt, createdAt);
	if (!scope || !id || !key || !content || !createdAt) return undefined;
	const legacyKind = asString(value.kind);
	const kind: MemoryKind = legacyKind === "user" ? "user" : legacyKind === "method" ? "procedure" : "project";
	const legacyStatus = asString(value.status);
	const status: MemoryStatus =
		legacyStatus === "active" || legacyStatus === "stale" || legacyStatus === "rejected" ? legacyStatus : "candidate";
	const staleReasonValue = asString(value.staleReason);
	const staleReason =
		staleReasonValue === "evidence_changed" ||
		staleReasonValue === "evidence_missing" ||
		staleReasonValue === "evidence_unreadable"
			? staleReasonValue
			: undefined;
	return {
		id,
		kind,
		claim: { subject: key, predicate: "value", value: content },
		content,
		contentHash: asString(value.contentHash),
		status: staleReasonValue === "replaced_by_user" ? "superseded" : status,
		source: kind === "user" ? "user" : "agent",
		importance: kind === "user" ? "core" : "normal",
		confidence: kind === "user" ? 1 : 0.8,
		scope,
		evidence: migrateLegacyEvidence(value.evidence),
		conflictWith: asStringArray(value.conflictWith),
		supersedes: [],
		validFrom: asString(value.approvedAt, createdAt),
		createdAt,
		updatedAt,
		usage: { recallCount: 0, adoptedCount: 0, helpfulCount: 0, harmfulCount: 0 },
		revision: typeof value.revision === "number" ? value.revision : 1,
		...(typeof value.approvedAt === "string" ? { approvedAt: value.approvedAt } : {}),
		...(typeof value.rejectedAt === "string" ? { rejectedAt: value.rejectedAt } : {}),
		...(typeof value.staleAt === "string" ? { staleAt: value.staleAt } : {}),
		...(staleReason ? { staleReason } : {}),
		...(staleReasonValue === "replaced_by_user" ? { validTo: updatedAt } : {}),
	};
}

function migrateLegacyStore(value: unknown): MemoryStoreData | undefined {
	if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.records)) return undefined;
	const records = value.records.map(migrateLegacyRecord).filter((record): record is MemoryRecord => !!record);
	if (records.length !== value.records.length) return undefined;
	return {
		schemaVersion: MEMORY_SCHEMA_VERSION,
		revision: typeof value.revision === "number" ? value.revision : 0,
		records,
		events: [],
	};
}

function parseStore(content: string | undefined): { store: MemoryStoreData; migrated: boolean } {
	if (!content?.trim() || content.trim() === "{}") return { store: emptyStore(), migrated: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("记忆文件损坏：不是有效的 JSON；原文件不会被覆盖");
	}
	if (memoryStoreValidator.Check(parsed)) return { store: structuredClone(parsed), migrated: false };
	const migrated = migrateLegacyStore(parsed);
	if (migrated && memoryStoreValidator.Check(migrated)) return { store: migrated, migrated: true };
	throw new Error("记忆文件损坏：数据格式无效；原文件不会被覆盖");
}

function serializeStore(store: MemoryStoreData): string {
	store.events = store.events.slice(-MAX_MEMORY_EVENTS);
	return `${JSON.stringify(store, null, 2)}\n`;
}

export class LockedJsonMemoryBackend implements MemoryBackend {
	private readonly storage: AuthStorageBackend;

	constructor(storage: AuthStorageBackend) {
		this.storage = storage;
	}

	async transact<T>(mutate: (store: MemoryStoreData) => Promise<MemoryBackendMutation<T>>): Promise<T> {
		return this.storage.withLockAsync(async (content) => {
			const loaded = parseStore(content);
			const mutation = await mutate(loaded.store);
			return {
				result: mutation.result,
				...(loaded.migrated || mutation.changed ? { next: serializeStore(loaded.store) } : {}),
			};
		});
	}
}
