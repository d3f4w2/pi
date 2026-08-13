import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson } from "./run-contract.ts";
import type { RunOutcome, RunReceiptEnvelope } from "./run-receipt.ts";

const POLICY_KEYS = new Set(["version", "allowedOutcomes", "requirements", "perRunLimits", "aggregateLimits"]);
const REQUIREMENT_KEYS = new Set([
	"headUnchanged",
	"scopeCompliant",
	"verificationForChanges",
	"allChecksPassed",
	"requiredChecks",
	"allowedScopes",
]);
const PER_RUN_LIMIT_KEYS = new Set([
	"durationMs",
	"totalTokens",
	"costUsd",
	"toolCalls",
	"toolErrors",
	"protocolErrors",
]);
const AGGREGATE_LIMIT_KEYS = new Set(["totalDurationMs", "totalTokens", "totalCostUsd", "totalToolCalls"]);
const OUTCOMES = new Set<RunOutcome>(["verified", "completed", "unverified", "failed", "noncompliant"]);

export interface CiRequirements {
	headUnchanged: boolean;
	scopeCompliant: boolean;
	verificationForChanges: boolean;
	allChecksPassed: boolean;
	requiredChecks: string[];
	allowedScopes: string[];
}

export interface CiPerRunLimits {
	durationMs?: number;
	totalTokens?: number;
	costUsd?: number;
	toolCalls?: number;
	toolErrors?: number;
	protocolErrors?: number;
}

export interface CiAggregateLimits {
	totalDurationMs?: number;
	totalTokens?: number;
	totalCostUsd?: number;
	totalToolCalls?: number;
}

export interface EffectiveCiPolicy {
	version: 1;
	allowedOutcomes: RunOutcome[];
	requirements: CiRequirements;
	perRunLimits: CiPerRunLimits;
	aggregateLimits: CiAggregateLimits;
}

export interface CiViolation {
	code: string;
	message: string;
	actual?: string | number;
	limit?: string | number;
}

export interface CiReceiptInput {
	file: string;
	envelope?: RunReceiptEnvelope;
	error?: string;
}

export interface CiReceiptResult {
	file: string;
	valid: boolean;
	passed: boolean;
	runId?: string;
	outcome?: RunOutcome;
	violations: CiViolation[];
}

export interface CiAggregateMetrics {
	totalDurationMs: number;
	totalTokens: number;
	totalCostUsd: number;
	totalToolCalls: number;
}

export interface CiGateReport {
	schemaVersion: 1;
	passed: boolean;
	policy: {
		source: string;
		sha256: string;
	};
	summary: {
		receipts: number;
		valid: number;
		passed: number;
		failed: number;
	};
	aggregate: CiAggregateMetrics;
	receipts: CiReceiptResult[];
	violations: CiViolation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
}

function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) throw new Error(`${label} contains unknown field "${key}".`);
	}
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer.`);
	}
	return value;
}

function nonNegativeNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative finite number.`);
	}
	return value;
}

function uniqueStrings(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	const strings = value.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new Error(`${label}[${index}] must be a non-empty string.`);
		}
		return entry.trim();
	});
	return [...new Set(strings)];
}

function normalizePolicyScope(value: string, label: string): string {
	const portable = value.replaceAll("\\", "/");
	if (path.posix.isAbsolute(portable) || /^[A-Za-z]:\//.test(portable)) {
		throw new Error(`${label} must be a relative path.`);
	}
	const normalized = path.posix.normalize(portable);
	if (normalized === ".." || normalized.startsWith("../")) throw new Error(`${label} must not leave the workspace.`);
	return normalized === "" ? "." : normalized;
}

function parseAllowedOutcomes(value: unknown): RunOutcome[] {
	if (value === undefined) return ["verified", "completed"];
	if (!Array.isArray(value) || value.length === 0) throw new Error("allowedOutcomes must be a non-empty array.");
	const outcomes = value.map((entry, index) => {
		if (typeof entry !== "string" || !OUTCOMES.has(entry as RunOutcome)) {
			throw new Error(`allowedOutcomes[${index}] is invalid.`);
		}
		return entry as RunOutcome;
	});
	return [...new Set(outcomes)];
}

function parseRequirements(value: unknown): CiRequirements {
	if (value !== undefined) assertRecord(value, "requirements");
	const requirements = value ?? {};
	assertKnownKeys(requirements, REQUIREMENT_KEYS, "requirements");
	const requiredChecks =
		requirements.requiredChecks === undefined
			? []
			: uniqueStrings(requirements.requiredChecks, "requirements.requiredChecks");
	const allowedScopes =
		requirements.allowedScopes === undefined
			? []
			: uniqueStrings(requirements.allowedScopes, "requirements.allowedScopes").map((scope, index) =>
					normalizePolicyScope(scope, `requirements.allowedScopes[${index}]`),
				);
	return {
		headUnchanged: optionalBoolean(requirements.headUnchanged, true, "requirements.headUnchanged"),
		scopeCompliant: optionalBoolean(requirements.scopeCompliant, true, "requirements.scopeCompliant"),
		verificationForChanges: optionalBoolean(
			requirements.verificationForChanges,
			true,
			"requirements.verificationForChanges",
		),
		allChecksPassed: optionalBoolean(requirements.allChecksPassed, true, "requirements.allChecksPassed"),
		requiredChecks,
		allowedScopes: [...new Set(allowedScopes)],
	};
}

function parsePerRunLimits(value: unknown): CiPerRunLimits {
	if (value !== undefined) assertRecord(value, "perRunLimits");
	const limits = value ?? {};
	assertKnownKeys(limits, PER_RUN_LIMIT_KEYS, "perRunLimits");
	const durationMs = nonNegativeInteger(limits.durationMs, "perRunLimits.durationMs");
	const totalTokens = nonNegativeInteger(limits.totalTokens, "perRunLimits.totalTokens");
	const costUsd = nonNegativeNumber(limits.costUsd, "perRunLimits.costUsd");
	const toolCalls = nonNegativeInteger(limits.toolCalls, "perRunLimits.toolCalls");
	return {
		...(durationMs === undefined ? {} : { durationMs }),
		...(totalTokens === undefined ? {} : { totalTokens }),
		...(costUsd === undefined ? {} : { costUsd }),
		...(toolCalls === undefined ? {} : { toolCalls }),
		toolErrors: nonNegativeInteger(limits.toolErrors, "perRunLimits.toolErrors") ?? 0,
		protocolErrors: nonNegativeInteger(limits.protocolErrors, "perRunLimits.protocolErrors") ?? 0,
	};
}

function parseAggregateLimits(value: unknown): CiAggregateLimits {
	if (value !== undefined) assertRecord(value, "aggregateLimits");
	const limits = value ?? {};
	assertKnownKeys(limits, AGGREGATE_LIMIT_KEYS, "aggregateLimits");
	const totalDurationMs = nonNegativeInteger(limits.totalDurationMs, "aggregateLimits.totalDurationMs");
	const totalTokens = nonNegativeInteger(limits.totalTokens, "aggregateLimits.totalTokens");
	const totalCostUsd = nonNegativeNumber(limits.totalCostUsd, "aggregateLimits.totalCostUsd");
	const totalToolCalls = nonNegativeInteger(limits.totalToolCalls, "aggregateLimits.totalToolCalls");
	return {
		...(totalDurationMs === undefined ? {} : { totalDurationMs }),
		...(totalTokens === undefined ? {} : { totalTokens }),
		...(totalCostUsd === undefined ? {} : { totalCostUsd }),
		...(totalToolCalls === undefined ? {} : { totalToolCalls }),
	};
}

export function createDefaultCiPolicy(): EffectiveCiPolicy {
	return {
		version: 1,
		allowedOutcomes: ["verified", "completed"],
		requirements: {
			headUnchanged: true,
			scopeCompliant: true,
			verificationForChanges: true,
			allChecksPassed: true,
			requiredChecks: [],
			allowedScopes: [],
		},
		perRunLimits: { toolErrors: 0, protocolErrors: 0 },
		aggregateLimits: {},
	};
}

export function parseCiPolicyText(text: string): EffectiveCiPolicy {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`CI policy is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	assertRecord(value, "CI policy");
	assertKnownKeys(value, POLICY_KEYS, "CI policy");
	if (value.version !== 1) throw new Error("CI policy version must be 1.");
	return {
		version: 1,
		allowedOutcomes: parseAllowedOutcomes(value.allowedOutcomes),
		requirements: parseRequirements(value.requirements),
		perRunLimits: parsePerRunLimits(value.perRunLimits),
		aggregateLimits: parseAggregateLimits(value.aggregateLimits),
	};
}

export function hashCiPolicy(policy: EffectiveCiPolicy): string {
	return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

function toolCallCount(envelope: RunReceiptEnvelope): number {
	return Object.values(envelope.receipt.execution.toolCalls).reduce((sum, count) => sum + count, 0);
}

function scopeIsAllowed(scope: string, allowedScopes: readonly string[]): boolean {
	return allowedScopes.some((allowed) => allowed === "." || scope === allowed || scope.startsWith(`${allowed}/`));
}

function addLimitViolation(
	violations: CiViolation[],
	code: string,
	label: string,
	actual: number,
	limit: number | undefined,
): void {
	if (limit !== undefined && actual > limit) {
		violations.push({ code, message: `${label} ${actual} exceeds limit ${limit}.`, actual, limit });
	}
}

function expectedReceiptOutcome(envelope: RunReceiptEnvelope): RunOutcome {
	const receipt = envelope.receipt;
	if (
		["timeout", "token_budget", "tool_budget", "iteration_budget"].includes(receipt.execution.terminationReason) ||
		receipt.workspace.headChanged ||
		receipt.workspace.scopeViolations.length > 0
	) {
		return "noncompliant";
	}
	if (receipt.execution.terminationReason !== "completed" || receipt.execution.exitCode !== 0) {
		return "failed";
	}
	const statuses = receipt.verification.flatMap((entry) => entry.checks.map((check) => check.status));
	if (statuses.some((status) => status === "failed" || status === "timed_out")) return "failed";
	if (receipt.workspace.changed.length === 0) return "completed";
	if (receipt.verification.length === 0 || receipt.verification.some((entry) => !entry.passed)) return "unverified";
	return "verified";
}

export function evaluateCiReceipt(envelope: RunReceiptEnvelope, policy: EffectiveCiPolicy): CiViolation[] {
	const receipt = envelope.receipt;
	const violations: CiViolation[] = [];
	const expectedOutcome = expectedReceiptOutcome(envelope);
	if (receipt.result.outcome !== expectedOutcome) {
		violations.push({
			code: "receipt.outcome_inconsistent",
			message: `Recorded outcome ${receipt.result.outcome} is inconsistent with evidence-derived outcome ${expectedOutcome}.`,
			actual: receipt.result.outcome,
			limit: expectedOutcome,
		});
	}
	const headsDiffer = receipt.workspace.headBefore !== receipt.workspace.headAfter;
	if (receipt.workspace.headChanged !== headsDiffer) {
		violations.push({
			code: "receipt.head_inconsistent",
			message: "workspace.headChanged is inconsistent with headBefore and headAfter.",
		});
	}
	const totalToolCalls = toolCallCount(envelope);
	if (receipt.execution.usage.totalTokens > receipt.contract.budget.maxTokens) {
		violations.push({
			code: "contract.token_budget_exceeded",
			message: "Receipt usage exceeds its own run contract Token budget.",
			actual: receipt.execution.usage.totalTokens,
			limit: receipt.contract.budget.maxTokens,
		});
	}
	if (totalToolCalls > receipt.contract.budget.maxToolCalls) {
		violations.push({
			code: "contract.tool_budget_exceeded",
			message: "Receipt tool calls exceed its own run contract budget.",
			actual: totalToolCalls,
			limit: receipt.contract.budget.maxToolCalls,
		});
	}
	if (!policy.allowedOutcomes.includes(receipt.result.outcome)) {
		violations.push({
			code: "outcome.disallowed",
			message: `Outcome ${receipt.result.outcome} is not allowed.`,
			actual: receipt.result.outcome,
			limit: policy.allowedOutcomes.join(","),
		});
	}
	if (policy.requirements.headUnchanged && receipt.workspace.headChanged) {
		violations.push({ code: "workspace.head_changed", message: "Workspace HEAD changed during the run." });
	}
	if (policy.requirements.scopeCompliant && receipt.workspace.scopeViolations.length > 0) {
		violations.push({
			code: "workspace.scope_violation",
			message: `Changes escaped the declared scope: ${receipt.workspace.scopeViolations.join(", ")}.`,
			actual: receipt.workspace.scopeViolations.length,
			limit: 0,
		});
	}
	if (
		policy.requirements.verificationForChanges &&
		receipt.workspace.changed.length > 0 &&
		(receipt.verification.length === 0 || receipt.verification.some((entry) => !entry.passed))
	) {
		violations.push({
			code: "verification.missing_or_failed",
			message: "Changed workspaces require successful independent verification.",
		});
	}
	const checks = receipt.verification.flatMap((entry) => entry.checks);
	if (
		policy.requirements.allChecksPassed &&
		(receipt.verification.some((entry) => !entry.passed) || checks.some((check) => check.status !== "passed"))
	) {
		violations.push({ code: "verification.check_failed", message: "At least one independent check did not pass." });
	}
	const passedChecks = new Set<string>(checks.filter((check) => check.status === "passed").map((check) => check.id));
	for (const requiredCheck of policy.requirements.requiredChecks) {
		if (!passedChecks.has(requiredCheck)) {
			violations.push({
				code: "verification.required_check_missing",
				message: `Required passing check ${requiredCheck} is missing.`,
				actual: requiredCheck,
			});
		}
	}
	for (const scope of receipt.contract.scope) {
		let normalizedScope: string;
		try {
			normalizedScope = normalizePolicyScope(scope, "receipt contract scope");
		} catch {
			violations.push({
				code: "contract.scope_invalid",
				message: `Declared scope ${scope} is not a safe repository-relative path.`,
				actual: scope,
			});
			continue;
		}
		if (
			policy.requirements.allowedScopes.length > 0 &&
			!scopeIsAllowed(normalizedScope, policy.requirements.allowedScopes)
		) {
			violations.push({
				code: "contract.scope_disallowed",
				message: `Declared scope ${normalizedScope} is outside policy roots.`,
				actual: normalizedScope,
				limit: policy.requirements.allowedScopes.join(","),
			});
		}
	}

	const limits = policy.perRunLimits;
	addLimitViolation(violations, "limit.duration", "Duration", receipt.durationMs, limits.durationMs);
	addLimitViolation(
		violations,
		"limit.tokens",
		"Total tokens",
		receipt.execution.usage.totalTokens,
		limits.totalTokens,
	);
	addLimitViolation(violations, "limit.cost", "Estimated cost", receipt.execution.usage.cost, limits.costUsd);
	addLimitViolation(violations, "limit.tool_calls", "Tool calls", totalToolCalls, limits.toolCalls);
	addLimitViolation(violations, "limit.tool_errors", "Tool errors", receipt.execution.toolErrors, limits.toolErrors);
	addLimitViolation(
		violations,
		"limit.protocol_errors",
		"Protocol errors",
		receipt.execution.protocolErrors,
		limits.protocolErrors,
	);
	return violations;
}

function aggregateMetrics(inputs: readonly CiReceiptInput[]): CiAggregateMetrics {
	const aggregate: CiAggregateMetrics = {
		totalDurationMs: 0,
		totalTokens: 0,
		totalCostUsd: 0,
		totalToolCalls: 0,
	};
	for (const input of inputs) {
		if (!input.envelope) continue;
		aggregate.totalDurationMs += input.envelope.receipt.durationMs;
		aggregate.totalTokens += input.envelope.receipt.execution.usage.totalTokens;
		aggregate.totalCostUsd += input.envelope.receipt.execution.usage.cost;
		aggregate.totalToolCalls += toolCallCount(input.envelope);
	}
	return aggregate;
}

function evaluateAggregate(metrics: CiAggregateMetrics, limits: CiAggregateLimits): CiViolation[] {
	const violations: CiViolation[] = [];
	addLimitViolation(
		violations,
		"aggregate.duration",
		"Aggregate duration",
		metrics.totalDurationMs,
		limits.totalDurationMs,
	);
	addLimitViolation(violations, "aggregate.tokens", "Aggregate tokens", metrics.totalTokens, limits.totalTokens);
	addLimitViolation(
		violations,
		"aggregate.cost",
		"Aggregate estimated cost",
		metrics.totalCostUsd,
		limits.totalCostUsd,
	);
	addLimitViolation(
		violations,
		"aggregate.tool_calls",
		"Aggregate tool calls",
		metrics.totalToolCalls,
		limits.totalToolCalls,
	);
	return violations;
}

export function evaluateCiGate(
	inputs: readonly CiReceiptInput[],
	policy: EffectiveCiPolicy,
	policySource: string,
): CiGateReport {
	const receipts = inputs.map((input): CiReceiptResult => {
		if (!input.envelope) {
			return {
				file: input.file,
				valid: false,
				passed: false,
				violations: [{ code: "receipt.invalid", message: input.error ?? "Receipt is invalid." }],
			};
		}
		const violations = evaluateCiReceipt(input.envelope, policy);
		return {
			file: input.file,
			valid: true,
			passed: violations.length === 0,
			runId: input.envelope.receipt.runId,
			outcome: input.envelope.receipt.result.outcome,
			violations,
		};
	});
	const aggregate = aggregateMetrics(inputs);
	const violations = evaluateAggregate(aggregate, policy.aggregateLimits);
	const passed = receipts.every((receipt) => receipt.passed) && violations.length === 0;
	return {
		schemaVersion: 1,
		passed,
		policy: { source: policySource, sha256: hashCiPolicy(policy) },
		summary: {
			receipts: receipts.length,
			valid: receipts.filter((receipt) => receipt.valid).length,
			passed: receipts.filter((receipt) => receipt.passed).length,
			failed: receipts.filter((receipt) => !receipt.passed).length,
		},
		aggregate,
		receipts,
		violations,
	};
}

export function formatCiGateReport(report: CiGateReport): string {
	const lines = [
		`Pigo CI gate: ${report.passed ? "PASS" : "FAIL"}`,
		`Policy: ${report.policy.source} · sha256:${report.policy.sha256}`,
	];
	for (const receipt of report.receipts) {
		const identity = receipt.runId && receipt.outcome ? ` · ${receipt.runId} · ${receipt.outcome}` : "";
		lines.push(`${receipt.passed ? "PASS" : "FAIL"} ${receipt.file}${identity}`);
		for (const violation of receipt.violations) lines.push(`  ${violation.code}: ${violation.message}`);
	}
	for (const violation of report.violations) lines.push(`FAIL ${violation.code}: ${violation.message}`);
	lines.push(
		`Summary: ${report.summary.passed}/${report.summary.receipts} passed · ${report.aggregate.totalTokens} tokens · ${report.aggregate.totalToolCalls} tool calls · $${report.aggregate.totalCostUsd.toFixed(4)}`,
	);
	return `${lines.join("\n")}\n`;
}
