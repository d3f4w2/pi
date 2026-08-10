import { type Static, Type } from "typebox";

export const EVOLUTION_SCHEMA_VERSION = 1;
export const MAX_EVOLUTION_SIGNALS = 200;
export const MAX_EVOLUTION_CANDIDATES = 100;
export const MAX_EVOLUTION_EVENTS = 500;
export const MAX_CANDIDATE_INSTRUCTION_LENGTH = 1_000;
export const MAX_CANDIDATE_TRIGGER_TERMS = 8;
export const MAX_CANDIDATE_EVALUATIONS = 10;

export const EvolutionProjectScopeSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 64, maxLength: 64 }),
	},
	{ additionalProperties: false },
);
export type EvolutionProjectScope = Static<typeof EvolutionProjectScopeSchema>;

export const EvolutionSignalStatusSchema = Type.Union([
	Type.Literal("observing"),
	Type.Literal("eligible"),
	Type.Literal("suppressed"),
	Type.Literal("linked"),
]);
export type EvolutionSignalStatus = Static<typeof EvolutionSignalStatusSchema>;

export const EvolutionSignalSchema = Type.Object(
	{
		id: Type.String({ pattern: "^es_[a-f0-9]{32}$" }),
		fingerprint: Type.String({ minLength: 64, maxLength: 64 }),
		scope: EvolutionProjectScopeSchema,
		status: EvolutionSignalStatusSchema,
		occurrences: Type.Integer({ minimum: 1 }),
		sourceRunIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 10 }),
		taskKind: Type.Union([Type.Literal("read_only"), Type.Literal("code_change")]),
		outcome: Type.Union([Type.Literal("failed"), Type.Literal("unverified"), Type.Literal("recovered")]),
		toolErrors: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 }),
		errorFingerprints: Type.Array(Type.String({ minLength: 64, maxLength: 64 }), { maxItems: 20 }),
		retries: Type.Integer({ minimum: 0 }),
		verification: Type.Union([
			Type.Literal("not_needed"),
			Type.Literal("passed"),
			Type.Literal("failed"),
			Type.Literal("missing"),
			Type.Literal("waived"),
		]),
		firstSeenAt: Type.String({ minLength: 1 }),
		lastSeenAt: Type.String({ minLength: 1 }),
		candidateId: Type.Optional(Type.String({ pattern: "^ec_[a-f0-9]{32}$" })),
	},
	{ additionalProperties: false },
);
export type EvolutionSignal = Static<typeof EvolutionSignalSchema>;

export const EvolutionCandidateKindSchema = Type.Union([Type.Literal("prompt"), Type.Literal("strategy")]);
export type EvolutionCandidateKind = Static<typeof EvolutionCandidateKindSchema>;

export const EvolutionCandidateStatusSchema = Type.Union([
	Type.Literal("proposed"),
	Type.Literal("evaluated"),
	Type.Literal("canary"),
	Type.Literal("awaiting_promotion"),
	Type.Literal("promoted"),
	Type.Literal("rejected"),
	Type.Literal("failed"),
	Type.Literal("rolled_back"),
	Type.Literal("superseded"),
]);
export type EvolutionCandidateStatus = Static<typeof EvolutionCandidateStatusSchema>;

export const EvolutionRunEvidenceSchema = Type.Object(
	{
		resultId: Type.String({ minLength: 1, maxLength: 100 }),
		passed: Type.Boolean(),
		verificationPassed: Type.Boolean(),
		budgetPassed: Type.Boolean(),
		durationMs: Type.Number({ minimum: 0 }),
		totalTokens: Type.Number({ minimum: 0 }),
		outputTokens: Type.Number({ minimum: 0 }),
		toolCalls: Type.Integer({ minimum: 0 }),
		toolErrors: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type EvolutionRunEvidence = Static<typeof EvolutionRunEvidenceSchema>;

export const EvolutionEvaluationSchema = Type.Object(
	{
		id: Type.String({ pattern: "^ee_[a-f0-9]{32}$" }),
		candidateDigest: Type.String({ minLength: 64, maxLength: 64 }),
		caseId: Type.String({ minLength: 1, maxLength: 100 }),
		provider: Type.String({ minLength: 1, maxLength: 100 }),
		model: Type.String({ minLength: 1, maxLength: 200 }),
		thinkingLevel: Type.String({ minLength: 1, maxLength: 30 }),
		baseline: EvolutionRunEvidenceSchema,
		candidate: EvolutionRunEvidenceSchema,
		gatePassed: Type.Boolean(),
		reasons: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 10 }),
		warnings: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 10 }),
		createdAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type EvolutionEvaluation = Static<typeof EvolutionEvaluationSchema>;

export const EvolutionApprovalSchema = Type.Object(
	{
		candidateDigest: Type.String({ minLength: 64, maxLength: 64 }),
		approvedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type EvolutionApproval = Static<typeof EvolutionApprovalSchema>;

export const EvolutionCanarySchema = Type.Object(
	{
		candidateDigest: Type.String({ minLength: 64, maxLength: 64 }),
		totalRuns: Type.Integer({ minimum: 1, maximum: 20 }),
		remainingRuns: Type.Integer({ minimum: 0, maximum: 20 }),
		successfulRuns: Type.Integer({ minimum: 0, maximum: 20 }),
		startedAt: Type.String({ minLength: 1 }),
		lastRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		previousStableId: Type.Optional(Type.String({ pattern: "^ec_[a-f0-9]{32}$" })),
	},
	{ additionalProperties: false },
);
export type EvolutionCanary = Static<typeof EvolutionCanarySchema>;

export const EvolutionCandidateSchema = Type.Object(
	{
		id: Type.String({ pattern: "^ec_[a-f0-9]{32}$" }),
		scope: EvolutionProjectScopeSchema,
		sourceSignalId: Type.String({ pattern: "^es_[a-f0-9]{32}$" }),
		parentId: Type.Optional(Type.String({ pattern: "^ec_[a-f0-9]{32}$" })),
		title: Type.String({ minLength: 1, maxLength: 120 }),
		problem: Type.String({ minLength: 1, maxLength: 500 }),
		hypothesis: Type.String({ minLength: 1, maxLength: 500 }),
		kind: EvolutionCandidateKindSchema,
		instruction: Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_INSTRUCTION_LENGTH }),
		triggerTerms: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
			maxItems: MAX_CANDIDATE_TRIGGER_TERMS,
		}),
		expectedEffect: Type.String({ minLength: 1, maxLength: 500 }),
		risk: Type.String({ minLength: 1, maxLength: 500 }),
		evalCaseId: Type.String({ minLength: 1, maxLength: 100 }),
		digest: Type.String({ minLength: 64, maxLength: 64 }),
		status: EvolutionCandidateStatusSchema,
		revision: Type.Integer({ minimum: 1 }),
		createdAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
		evaluations: Type.Array(EvolutionEvaluationSchema, { maxItems: MAX_CANDIDATE_EVALUATIONS }),
		approval: Type.Optional(EvolutionApprovalSchema),
		canary: Type.Optional(EvolutionCanarySchema),
		promotedAt: Type.Optional(Type.String({ minLength: 1 })),
		endedAt: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export type EvolutionCandidate = Static<typeof EvolutionCandidateSchema>;

export const EvolutionSettingsSchema = Type.Object(
	{
		enabled: Type.Boolean(),
		signalThreshold: Type.Integer({ minimum: 2, maximum: 10 }),
		canaryRuns: Type.Integer({ minimum: 1, maximum: 10 }),
	},
	{ additionalProperties: false },
);
export type EvolutionSettings = Static<typeof EvolutionSettingsSchema>;

export const EvolutionEventTypeSchema = Type.Union([
	Type.Literal("signal_observed"),
	Type.Literal("signal_eligible"),
	Type.Literal("signal_suppressed"),
	Type.Literal("candidate_proposed"),
	Type.Literal("candidate_evaluated"),
	Type.Literal("candidate_rejected"),
	Type.Literal("canary_started"),
	Type.Literal("canary_passed"),
	Type.Literal("candidate_promoted"),
	Type.Literal("candidate_rolled_back"),
]);
export type EvolutionEventType = Static<typeof EvolutionEventTypeSchema>;

export const EvolutionAuditEventSchema = Type.Object(
	{
		id: Type.String({ pattern: "^ea_[a-f0-9]{32}$" }),
		type: EvolutionEventTypeSchema,
		timestamp: Type.String({ minLength: 1 }),
		subjectId: Type.String({ minLength: 1, maxLength: 100 }),
		digest: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
		detail: Type.Optional(Type.String({ maxLength: 240 })),
	},
	{ additionalProperties: false },
);
export type EvolutionAuditEvent = Static<typeof EvolutionAuditEventSchema>;

export const EvolutionStoreDataSchema = Type.Object(
	{
		schemaVersion: Type.Literal(EVOLUTION_SCHEMA_VERSION),
		revision: Type.Integer({ minimum: 0 }),
		settings: EvolutionSettingsSchema,
		signals: Type.Array(EvolutionSignalSchema, { maxItems: MAX_EVOLUTION_SIGNALS }),
		candidates: Type.Array(EvolutionCandidateSchema, { maxItems: MAX_EVOLUTION_CANDIDATES }),
		events: Type.Array(EvolutionAuditEventSchema, { maxItems: MAX_EVOLUTION_EVENTS }),
	},
	{ additionalProperties: false },
);
export type EvolutionStoreData = Static<typeof EvolutionStoreDataSchema>;

export interface EvolutionCandidateDraft {
	title: string;
	problem: string;
	hypothesis: string;
	kind: EvolutionCandidateKind;
	instruction: string;
	triggerTerms: string[];
	expectedEffect: string;
	risk: string;
	evalCaseId: string;
}

export interface EvolutionSnapshot {
	revision: number;
	settings: EvolutionSettings;
	signals: EvolutionSignal[];
	candidates: EvolutionCandidate[];
	events: EvolutionAuditEvent[];
}

export interface EvolutionPromptContext {
	systemPrompt?: string;
	appliedCandidateIds: string[];
	canaryCandidateId?: string;
}

export interface CanaryRunOutcome {
	action: "none" | "continued" | "awaiting_promotion" | "rolled_back";
	candidate?: EvolutionCandidate;
}
