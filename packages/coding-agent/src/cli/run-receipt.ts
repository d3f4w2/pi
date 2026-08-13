import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VerifyCheckDetails, VerifyOperation } from "../extensions/verify/types.ts";
import type { RunBudgetContract, RunVerificationContract } from "./run-contract.ts";
import { canonicalJson } from "./run-contract.ts";
import type { WorkspaceChange } from "./run-workspace.ts";

export type RunOutcome = "verified" | "completed" | "unverified" | "failed" | "noncompliant";

export type RunTerminationReason =
	| "completed"
	| "agent_failed"
	| "timeout"
	| "token_budget"
	| "tool_budget"
	| "iteration_budget"
	| "user_stopped"
	| "protocol_error"
	| "spawn_error";

export interface PrivateTextEvidence {
	sha256: string;
	utf8Bytes: number;
}

export interface RunUsageEvidence {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
}

export interface RunVerificationEvidence {
	operation: VerifyOperation;
	path: string;
	passed: boolean;
	durationMs: number;
	checks: Array<Pick<VerifyCheckDetails, "id" | "status" | "durationMs" | "command">>;
}

export interface RunReceipt {
	schemaVersion: 1;
	runId: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	contract: {
		sha256: string;
		task: PrivateTextEvidence;
		scope: string[];
		verification: RunVerificationContract[];
		budget: RunBudgetContract;
	};
	workspace: {
		coverage: "git-tracked-and-unignored";
		headBefore: string | null;
		headAfter: string | null;
		headChanged: boolean;
		beforeDigest: string;
		afterDigest: string;
		changed: WorkspaceChange[];
		scopeViolations: string[];
	};
	execution: {
		exitCode: number | null;
		terminationReason: RunTerminationReason;
		turns: number;
		toolCalls: Record<string, number>;
		toolErrors: number;
		usage: RunUsageEvidence;
		model?: { provider: string; id: string };
		finalResponse?: { sha256: string; characters: number };
		protocolErrors: number;
	};
	verification: RunVerificationEvidence[];
	result: { outcome: RunOutcome };
}

export interface RunReceiptEnvelope {
	receipt: RunReceipt;
	integrity: {
		algorithm: "sha256";
		canonicalization: "json-sorted-keys-v1";
		digest: string;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`回执 ${label} 必须是对象。`);
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`回执 ${label} 必须是非空字符串。`);
}

function assertHash(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`回执 ${label} 必须是 SHA-256 十六进制摘要。`);
	}
}

function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`回执 ${label} 必须是非负有限数值。`);
	}
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`回执 ${label} 必须是非负安全整数。`);
	}
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`回执 ${label} 必须是正安全整数。`);
	}
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		throw new Error(`回执 ${label} 必须是非空字符串组成的数组。`);
	}
}

function assertWorkspacePath(value: unknown, label: string): asserts value is string {
	assertString(value, label);
	if (value.includes("\\") || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
		throw new Error(`回执 ${label} 必须是规范的工作区相对路径。`);
	}
	const normalized = path.posix.normalize(value);
	if (normalized !== value || normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`回执 ${label} 必须是规范的工作区相对路径。`);
	}
}

function assertVerificationContracts(value: unknown): void {
	if (!Array.isArray(value)) throw new Error("回执 contract.verification 必须是数组。");
	const operations = new Set(["auto", "typecheck", "test", "lint"]);
	for (const [index, entry] of value.entries()) {
		assertRecord(entry, `contract.verification[${index}]`);
		if (!operations.has(String(entry.operation))) throw new Error("回执包含未知验证操作。");
		assertWorkspacePath(entry.path, `contract.verification[${index}].path`);
		assertPositiveInteger(entry.timeoutSeconds, `contract.verification[${index}].timeoutSeconds`);
	}
}

function assertContract(value: unknown): void {
	assertRecord(value, "contract");
	assertHash(value.sha256, "contract.sha256");
	assertRecord(value.task, "contract.task");
	assertHash(value.task.sha256, "contract.task.sha256");
	assertNonNegativeInteger(value.task.utf8Bytes, "contract.task.utf8Bytes");
	assertStringArray(value.scope, "contract.scope");
	for (const [index, scope] of value.scope.entries()) assertWorkspacePath(scope, `contract.scope[${index}]`);
	assertVerificationContracts(value.verification);
	assertRecord(value.budget, "contract.budget");
	assertPositiveInteger(value.budget.timeoutSeconds, "contract.budget.timeoutSeconds");
	assertPositiveInteger(value.budget.maxTokens, "contract.budget.maxTokens");
	assertPositiveInteger(value.budget.maxToolCalls, "contract.budget.maxToolCalls");
}

function assertWorkspace(value: unknown): void {
	assertRecord(value, "workspace");
	if (value.coverage !== "git-tracked-and-unignored") throw new Error("回执 workspace.coverage 无效。");
	for (const field of ["headBefore", "headAfter"] as const) {
		if (
			value[field] !== null &&
			(typeof value[field] !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value[field]))
		) {
			throw new Error(`回执 workspace.${field} 无效。`);
		}
	}
	if (typeof value.headChanged !== "boolean") throw new Error("回执 workspace.headChanged 必须是布尔值。");
	assertHash(value.beforeDigest, "workspace.beforeDigest");
	assertHash(value.afterDigest, "workspace.afterDigest");
	if (!Array.isArray(value.changed)) throw new Error("回执 workspace.changed 必须是数组。");
	for (const [index, entry] of value.changed.entries()) {
		assertRecord(entry, `workspace.changed[${index}]`);
		assertWorkspacePath(entry.path, `workspace.changed[${index}].path`);
		assertString(entry.before, `workspace.changed[${index}].before`);
		assertString(entry.after, `workspace.changed[${index}].after`);
	}
	assertStringArray(value.scopeViolations, "workspace.scopeViolations");
	for (const [index, scopeViolation] of value.scopeViolations.entries()) {
		assertWorkspacePath(scopeViolation, `workspace.scopeViolations[${index}]`);
	}
}

function assertExecution(value: unknown): void {
	assertRecord(value, "execution");
	if (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || typeof value.exitCode !== "number")) {
		throw new Error("回执 execution.exitCode 无效。");
	}
	const terminationReasons = new Set<RunTerminationReason>([
		"completed",
		"agent_failed",
		"timeout",
		"token_budget",
		"tool_budget",
		"iteration_budget",
		"user_stopped",
		"protocol_error",
		"spawn_error",
	]);
	if (
		typeof value.terminationReason !== "string" ||
		!terminationReasons.has(value.terminationReason as RunTerminationReason)
	) {
		throw new Error("回执 execution.terminationReason 无效。");
	}
	assertNonNegativeInteger(value.turns, "execution.turns");
	assertRecord(value.toolCalls, "execution.toolCalls");
	for (const [name, count] of Object.entries(value.toolCalls)) {
		assertString(name, "execution.toolCalls name");
		assertNonNegativeInteger(count, `execution.toolCalls.${name}`);
	}
	assertNonNegativeInteger(value.toolErrors, "execution.toolErrors");
	assertRecord(value.usage, "execution.usage");
	for (const field of [
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"totalTokens",
		"cost",
	] as const) {
		if (field === "cost") assertNonNegativeNumber(value.usage[field], `execution.usage.${field}`);
		else assertNonNegativeInteger(value.usage[field], `execution.usage.${field}`);
	}
	if (value.model !== undefined) {
		assertRecord(value.model, "execution.model");
		assertString(value.model.provider, "execution.model.provider");
		assertString(value.model.id, "execution.model.id");
	}
	if (value.finalResponse !== undefined) {
		assertRecord(value.finalResponse, "execution.finalResponse");
		assertHash(value.finalResponse.sha256, "execution.finalResponse.sha256");
		assertNonNegativeInteger(value.finalResponse.characters, "execution.finalResponse.characters");
	}
	assertNonNegativeInteger(value.protocolErrors, "execution.protocolErrors");
}

function assertVerificationEvidence(value: unknown): void {
	if (!Array.isArray(value)) throw new Error("回执 verification 必须是数组。");
	const operations = new Set(["auto", "typecheck", "test", "lint"]);
	const statuses = new Set(["passed", "failed", "unavailable", "timed_out"]);
	for (const [index, entry] of value.entries()) {
		assertRecord(entry, `verification[${index}]`);
		if (!operations.has(String(entry.operation))) throw new Error("回执包含未知验证操作。");
		assertWorkspacePath(entry.path, `verification[${index}].path`);
		if (typeof entry.passed !== "boolean") throw new Error(`回执 verification[${index}].passed 无效。`);
		assertNonNegativeInteger(entry.durationMs, `verification[${index}].durationMs`);
		if (!Array.isArray(entry.checks)) throw new Error(`回执 verification[${index}].checks 必须是数组。`);
		for (const [checkIndex, check] of entry.checks.entries()) {
			assertRecord(check, `verification[${index}].checks[${checkIndex}]`);
			assertString(check.id, `verification[${index}].checks[${checkIndex}].id`);
			if (!statuses.has(String(check.status))) throw new Error("回执包含未知验证状态。");
			assertNonNegativeInteger(check.durationMs, `verification[${index}].checks[${checkIndex}].durationMs`);
			if (check.command !== undefined)
				assertString(check.command, `verification[${index}].checks[${checkIndex}].command`);
		}
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function receiptDigest(receipt: RunReceipt): string {
	return createHash("sha256").update(canonicalJson(receipt)).digest("hex");
}

export function hashPrivateText(text: string): PrivateTextEvidence {
	return {
		sha256: createHash("sha256").update(text).digest("hex"),
		utf8Bytes: Buffer.byteLength(text),
	};
}

export function createRunReceiptEnvelope(receipt: RunReceipt): RunReceiptEnvelope {
	return {
		receipt,
		integrity: {
			algorithm: "sha256",
			canonicalization: "json-sorted-keys-v1",
			digest: receiptDigest(receipt),
		},
	};
}

function validateEnvelopeShape(value: unknown): asserts value is RunReceiptEnvelope {
	if (!isRecord(value) || !isRecord(value.receipt) || !isRecord(value.integrity)) {
		throw new Error("回执必须包含 receipt 和 integrity 对象。");
	}
	if (value.receipt.schemaVersion !== 1) throw new Error("回执 schemaVersion 必须是 1。");
	if (typeof value.receipt.runId !== "string" || value.receipt.runId.length === 0) {
		throw new Error("回执缺少 runId。");
	}
	assertString(value.receipt.startedAt, "startedAt");
	assertString(value.receipt.finishedAt, "finishedAt");
	if (
		!Number.isFinite(Date.parse(value.receipt.startedAt)) ||
		!Number.isFinite(Date.parse(value.receipt.finishedAt))
	) {
		throw new Error("回执时间字段无效。");
	}
	assertNonNegativeInteger(value.receipt.durationMs, "durationMs");
	assertContract(value.receipt.contract);
	assertWorkspace(value.receipt.workspace);
	assertExecution(value.receipt.execution);
	assertVerificationEvidence(value.receipt.verification);
	if (!isRecord(value.receipt.result)) throw new Error("回执缺少 result。");
	const outcomes = new Set<RunOutcome>(["verified", "completed", "unverified", "failed", "noncompliant"]);
	if (typeof value.receipt.result.outcome !== "string" || !outcomes.has(value.receipt.result.outcome as RunOutcome)) {
		throw new Error("回执 outcome 无效。");
	}
	if (
		value.integrity.algorithm !== "sha256" ||
		value.integrity.canonicalization !== "json-sorted-keys-v1" ||
		typeof value.integrity.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.integrity.digest)
	) {
		throw new Error("回执完整性字段无效。");
	}
}

export function verifyRunReceiptText(text: string): RunReceiptEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`回执不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
	validateEnvelopeShape(value);
	const expected = receiptDigest(value.receipt);
	if (!timingSafeEqual(Buffer.from(value.integrity.digest, "hex"), Buffer.from(expected, "hex"))) {
		throw new Error("回执完整性校验失败：内容与 SHA-256 摘要不一致。");
	}
	return value;
}

export async function writeRunReceipt(receiptPath: string, envelope: RunReceiptEnvelope): Promise<void> {
	const absolutePath = path.resolve(receiptPath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
	try {
		await writeFile(absolutePath, serialized, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (errorCode(error) === "EEXIST") {
			if ((await readFile(absolutePath, "utf8")) === serialized) return;
			throw new Error(`回执文件已存在且内容不同，不会覆盖：${absolutePath}`);
		}
		throw error;
	}
}
