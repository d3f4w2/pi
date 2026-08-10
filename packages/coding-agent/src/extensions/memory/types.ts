import { type Static, Type } from "typebox";

export const MEMORY_SCHEMA_VERSION = 2;
export const MAX_MEMORY_RECORDS = 500;
export const MAX_MEMORY_EVENTS = 2000;
export const MAX_MEMORY_FIELD_LENGTH = 160;
export const MAX_MEMORY_CONTENT_LENGTH = 1200;
export const MAX_MEMORY_EVIDENCE_FILES = 5;
export const MAX_MEMORY_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const MAX_MEMORY_EVIDENCE_EXCERPT_LENGTH = 1200;
export const MAX_RECALLED_MEMORIES = 5;
export const MAX_MEMORY_RECALL_QUERY_LENGTH = 400;
export const MAX_MEMORY_CONTEXT_CHARACTERS = 1500;

export const MemoryKindSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("project"),
	Type.Literal("episode"),
	Type.Literal("procedure"),
]);
export type MemoryKind = Static<typeof MemoryKindSchema>;

export const MemoryStatusSchema = Type.Union([
	Type.Literal("candidate"),
	Type.Literal("active"),
	Type.Literal("superseded"),
	Type.Literal("stale"),
	Type.Literal("rejected"),
]);
export type MemoryStatus = Static<typeof MemoryStatusSchema>;

export const MemoryStaleReasonSchema = Type.Union([
	Type.Literal("evidence_changed"),
	Type.Literal("evidence_missing"),
	Type.Literal("evidence_unreadable"),
]);
export type MemoryStaleReason = Static<typeof MemoryStaleReasonSchema>;

export const MemoryImportanceSchema = Type.Union([Type.Literal("core"), Type.Literal("normal")]);
export type MemoryImportance = Static<typeof MemoryImportanceSchema>;

export const MemorySourceSchema = Type.Union([Type.Literal("user"), Type.Literal("agent")]);
export type MemorySource = Static<typeof MemorySourceSchema>;

export const MemoryClaimSchema = Type.Object(
	{
		subject: Type.String({ minLength: 1, maxLength: MAX_MEMORY_FIELD_LENGTH }),
		predicate: Type.String({ minLength: 1, maxLength: MAX_MEMORY_FIELD_LENGTH }),
		value: Type.String({ minLength: 1, maxLength: MAX_MEMORY_CONTENT_LENGTH }),
	},
	{ additionalProperties: false },
);
export type MemoryClaim = Static<typeof MemoryClaimSchema>;

export const GlobalMemoryScopeSchema = Type.Object({ type: Type.Literal("global") }, { additionalProperties: false });
export type GlobalMemoryScope = Static<typeof GlobalMemoryScopeSchema>;

export const ProjectMemoryScopeSchema = Type.Object(
	{
		type: Type.Literal("project"),
		projectId: Type.String({ minLength: 64, maxLength: 64 }),
		projectRoot: Type.String({ minLength: 1 }),
		branch: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type ProjectMemoryScope = Static<typeof ProjectMemoryScopeSchema>;

export const MemoryScopeSchema = Type.Union([GlobalMemoryScopeSchema, ProjectMemoryScopeSchema]);
export type MemoryScope = Static<typeof MemoryScopeSchema>;

export const FileMemoryEvidenceSchema = Type.Object(
	{
		type: Type.Literal("file"),
		path: Type.String({ minLength: 1 }),
		mode: Type.Union([Type.Literal("excerpt"), Type.Literal("file")]),
		digest: Type.String({ minLength: 64, maxLength: 64 }),
		excerpt: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_MEMORY_EVIDENCE_EXCERPT_LENGTH })),
		startLine: Type.Optional(Type.Integer({ minimum: 1 })),
		endLine: Type.Optional(Type.Integer({ minimum: 1 })),
		size: Type.Integer({ minimum: 0, maximum: MAX_MEMORY_EVIDENCE_BYTES }),
		capturedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type FileMemoryEvidence = Static<typeof FileMemoryEvidenceSchema>;

export const UserConfirmationEvidenceSchema = Type.Object(
	{
		type: Type.Literal("user_confirmation"),
		capturedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type UserConfirmationEvidence = Static<typeof UserConfirmationEvidenceSchema>;

export const MemoryEvidenceSchema = Type.Union([FileMemoryEvidenceSchema, UserConfirmationEvidenceSchema]);
export type MemoryEvidence = Static<typeof MemoryEvidenceSchema>;

export const MemoryUsageSchema = Type.Object(
	{
		recallCount: Type.Integer({ minimum: 0 }),
		adoptedCount: Type.Integer({ minimum: 0 }),
		helpfulCount: Type.Integer({ minimum: 0 }),
		harmfulCount: Type.Integer({ minimum: 0 }),
		lastRecalledAt: Type.Optional(Type.String({ minLength: 1 })),
		lastFeedbackAt: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export type MemoryUsage = Static<typeof MemoryUsageSchema>;

export const MemoryRecordSchema = Type.Object(
	{
		id: Type.String({ pattern: "^m_[a-f0-9]{32}$" }),
		kind: MemoryKindSchema,
		claim: MemoryClaimSchema,
		content: Type.String({ minLength: 1, maxLength: MAX_MEMORY_CONTENT_LENGTH }),
		contentHash: Type.String({ minLength: 64, maxLength: 64 }),
		status: MemoryStatusSchema,
		source: MemorySourceSchema,
		importance: MemoryImportanceSchema,
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		scope: MemoryScopeSchema,
		evidence: Type.Array(MemoryEvidenceSchema, { maxItems: MAX_MEMORY_EVIDENCE_FILES + 1 }),
		conflictWith: Type.Array(Type.String({ pattern: "^m_[a-f0-9]{32}$" }), { maxItems: MAX_MEMORY_RECORDS }),
		supersedes: Type.Array(Type.String({ pattern: "^m_[a-f0-9]{32}$" }), { maxItems: MAX_MEMORY_RECORDS }),
		supersededBy: Type.Optional(Type.String({ pattern: "^m_[a-f0-9]{32}$" })),
		validFrom: Type.String({ minLength: 1 }),
		validTo: Type.Optional(Type.String({ minLength: 1 })),
		createdAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
		approvedAt: Type.Optional(Type.String({ minLength: 1 })),
		rejectedAt: Type.Optional(Type.String({ minLength: 1 })),
		staleAt: Type.Optional(Type.String({ minLength: 1 })),
		staleReason: Type.Optional(MemoryStaleReasonSchema),
		usage: MemoryUsageSchema,
		revision: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type MemoryRecord = Static<typeof MemoryRecordSchema>;

export const MemoryEventTypeSchema = Type.Union([
	Type.Literal("proposed"),
	Type.Literal("activated"),
	Type.Literal("rejected"),
	Type.Literal("superseded"),
	Type.Literal("stale"),
	Type.Literal("recalled"),
	Type.Literal("feedback"),
	Type.Literal("forgotten"),
]);
export type MemoryEventType = Static<typeof MemoryEventTypeSchema>;

export const MemoryAuditEventSchema = Type.Object(
	{
		id: Type.String({ pattern: "^me_[a-f0-9]{32}$" }),
		type: MemoryEventTypeSchema,
		recordId: Type.String({ pattern: "^m_[a-f0-9]{32}$" }),
		timestamp: Type.String({ minLength: 1 }),
		detail: Type.Optional(Type.String({ maxLength: 120 })),
	},
	{ additionalProperties: false },
);
export type MemoryAuditEvent = Static<typeof MemoryAuditEventSchema>;

export const MemoryStoreDataSchema = Type.Object(
	{
		schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
		revision: Type.Integer({ minimum: 0 }),
		records: Type.Array(MemoryRecordSchema, { maxItems: MAX_MEMORY_RECORDS }),
		events: Type.Array(MemoryAuditEventSchema, { maxItems: MAX_MEMORY_EVENTS }),
	},
	{ additionalProperties: false },
);
export type MemoryStoreData = Static<typeof MemoryStoreDataSchema>;

export interface MemoryEvidenceInput {
	path: string;
	quote?: string;
}

export interface WriteMemoryInput {
	source: MemorySource;
	kind: MemoryKind;
	claim: MemoryClaim;
	content: string;
	evidence: MemoryEvidenceInput[];
	importance?: MemoryImportance;
	confidence?: number;
}

export type MemoryFeedbackOutcome = "adopted" | "helpful" | "harmful" | "neutral";

export interface MemoryRecallHit {
	record: MemoryRecord;
	score: number;
	reasons: string[];
}

export interface MemoryRecallResult {
	hits: MemoryRecallHit[];
	staleRecords: MemoryRecord[];
}

export interface MemoryRecallOptions {
	includeCore?: boolean;
	limit?: number;
}
