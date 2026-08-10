import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import type { AgentEvalResult } from "../evals/types.ts";
import { containsAuthorityDirective, containsSensitiveCredential } from "../memory/security.ts";
import type { RunRecord } from "../run-metrics/types.ts";
import { type EvolutionBackend, LockedJsonEvolutionBackend } from "./backend.ts";
import {
	type CanaryRunOutcome,
	type EvolutionAuditEvent,
	type EvolutionCandidate,
	type EvolutionCandidateDraft,
	type EvolutionEvaluation,
	type EvolutionProjectScope,
	type EvolutionPromptContext,
	type EvolutionRunEvidence,
	type EvolutionSignal,
	type EvolutionSnapshot,
	MAX_CANDIDATE_EVALUATIONS,
	MAX_CANDIDATE_INSTRUCTION_LENGTH,
	MAX_CANDIDATE_TRIGGER_TERMS,
	MAX_EVOLUTION_CANDIDATES,
} from "./types.ts";

const MAX_TEXT = 500;
const MAX_PROMPT_CHAIN = 8;
const SIGNAL_RUN_IDS = 10;

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

function containsUnsafeCandidateDirective(value: string): boolean {
	return [
		/\b(?:auth\.json|credentials?|secrets?|api[_ -]?keys?|access[_ -]?tokens?|passwords?)\b/iu,
		/(?:凭据|密钥|口令|密码|认证文件)/u,
		/\b(?:curl|wget|https?:\/\/)/iu,
		/\b(?:npm|pnpm|yarn|pip|pipx|go)\s+install\b/iu,
		/(?:安装|新增|添加).{0,16}(?:依赖|工具|插件)/u,
		/\b(?:register|add|install).{0,16}(?:tool|plugin|dependency)\b/iu,
		/(?:忽略|覆盖).{0,20}(?:用户|系统|之前|当前).{0,12}(?:要求|指令|提示)/u,
		/\b(?:ignore|override).{0,24}(?:user|system|previous|current).{0,16}(?:request|instruction|prompt)\b/iu,
	].some((pattern) => pattern.test(value));
}

function sameProject(left: EvolutionProjectScope, right: EvolutionProjectScope): boolean {
	return left.projectId === right.projectId;
}

function id(prefix: "es" | "ec" | "ee" | "ea"): string {
	return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function addEvent(
	store: { events: EvolutionAuditEvent[] },
	type: EvolutionAuditEvent["type"],
	subjectId: string,
	now: Date,
	digest?: string,
	detail?: string,
): void {
	store.events.push({
		id: id("ea"),
		type,
		timestamp: now.toISOString(),
		subjectId,
		...(digest ? { digest } : {}),
		...(detail ? { detail: detail.slice(0, 240) } : {}),
	});
}

function failedTools(record: RunRecord): string[] {
	return Object.entries(record.tools)
		.filter(([, usage]) => usage.errors > 0)
		.map(([name]) => name)
		.sort();
}

function errorFingerprints(record: RunRecord): string[] {
	return [...new Set(Object.values(record.tools).flatMap((usage) => usage.errorFingerprints ?? []))]
		.sort()
		.slice(0, 20);
}

function signalOutcome(record: RunRecord): EvolutionSignal["outcome"] | undefined {
	if (record.outcome === "aborted") return undefined;
	if (record.outcome === "failed") return "failed";
	if (record.outcome === "unverified") return "unverified";
	if (record.retries > 0 || failedTools(record).length > 0) return "recovered";
	return undefined;
}

function signalFingerprint(record: RunRecord, outcome: EvolutionSignal["outcome"], tools: readonly string[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				taskKind: record.taskKind,
				outcome,
				toolErrors: tools,
				errorFingerprints: errorFingerprints(record),
				hadRetry: record.retries > 0,
				verification: record.evidence.verification,
			}),
		)
		.digest("hex");
}

function normalizedDraft(draft: EvolutionCandidateDraft): EvolutionCandidateDraft {
	const triggerTerms = [
		...new Set(
			draft.triggerTerms
				.map((term) => normalizeText(term, "触发词", 80))
				.map(canonical)
				.filter(Boolean),
		),
	].slice(0, MAX_CANDIDATE_TRIGGER_TERMS);
	if (draft.kind === "prompt" && triggerTerms.length > 0) throw new Error("通用提示候选不能设置触发词");
	if (draft.kind === "strategy" && triggerTerms.length === 0) throw new Error("触发式策略至少需要一个触发词");
	return {
		title: normalizeText(draft.title, "候选标题", 120),
		problem: normalizeText(draft.problem, "问题", MAX_TEXT),
		hypothesis: normalizeText(draft.hypothesis, "改进假设", MAX_TEXT),
		kind: draft.kind,
		instruction: normalizeText(draft.instruction, "候选规则", MAX_CANDIDATE_INSTRUCTION_LENGTH),
		triggerTerms,
		expectedEffect: normalizeText(draft.expectedEffect, "预期效果", MAX_TEXT),
		risk: normalizeText(draft.risk, "风险", MAX_TEXT),
		evalCaseId: normalizeText(draft.evalCaseId, "评测案例", 100),
	};
}

function candidateDigest(
	draft: EvolutionCandidateDraft,
	scope: EvolutionProjectScope,
	sourceSignalId: string,
	parent?: Pick<EvolutionCandidate, "id" | "digest">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				draft,
				projectId: scope.projectId,
				sourceSignalId,
				parent: parent ? { id: parent.id, digest: parent.digest } : null,
			}),
		)
		.digest("hex");
}

function draftFromCandidate(candidate: EvolutionCandidate): EvolutionCandidateDraft {
	return {
		title: candidate.title,
		problem: candidate.problem,
		hypothesis: candidate.hypothesis,
		kind: candidate.kind,
		instruction: candidate.instruction,
		triggerTerms: [...candidate.triggerTerms],
		expectedEffect: candidate.expectedEffect,
		risk: candidate.risk,
		evalCaseId: candidate.evalCaseId,
	};
}

function runEvidence(result: AgentEvalResult): EvolutionRunEvidence {
	return {
		resultId: result.id,
		passed: result.passed,
		verificationPassed: result.verificationPassed === true,
		budgetPassed: result.budgetPassed === true,
		durationMs: Math.max(0, result.durationMs),
		totalTokens: Math.max(0, result.totalTokens),
		outputTokens: Math.max(0, result.outputTokens ?? 0),
		toolCalls: Math.max(0, Math.trunc(result.toolCalls)),
		toolErrors: Math.max(0, Math.trunc(result.toolErrors)),
	};
}

function evaluationFor(
	candidate: EvolutionCandidate,
	baselineResult: AgentEvalResult,
	candidateResult: AgentEvalResult,
	now: Date,
): EvolutionEvaluation {
	if (baselineResult.caseId !== candidate.evalCaseId || candidateResult.caseId !== candidate.evalCaseId) {
		throw new Error("A/B 结果与候选指定案例不一致");
	}
	if (
		baselineResult.provider !== candidateResult.provider ||
		baselineResult.model !== candidateResult.model ||
		baselineResult.thinkingLevel !== candidateResult.thinkingLevel
	) {
		throw new Error("A/B 必须使用相同模型和思考等级");
	}
	const baseline = runEvidence(baselineResult);
	const evaluated = runEvidence(candidateResult);
	const reasons: string[] = [];
	const warnings: string[] = [];
	if (!evaluated.verificationPassed) reasons.push("候选没有通过隐藏验收");
	if (!evaluated.budgetPassed) reasons.push("候选超过评测预算");
	if (!evaluated.passed) reasons.push("候选任务未通过");
	if (baseline.passed && !evaluated.passed) reasons.push("候选使原本通过的案例退步");
	if (evaluated.toolErrors > baseline.toolErrors) warnings.push("候选产生了更多工具错误");
	if (baseline.totalTokens > 0 && evaluated.totalTokens > baseline.totalTokens * 1.25) {
		warnings.push("候选总 Token 比基线高 25% 以上");
	}
	if (baseline.durationMs > 0 && evaluated.durationMs > baseline.durationMs * 1.5) {
		warnings.push("候选耗时比基线高 50% 以上");
	}
	return {
		id: id("ee"),
		candidateDigest: candidate.digest,
		caseId: candidate.evalCaseId,
		provider: candidateResult.provider,
		model: candidateResult.model,
		thinkingLevel: candidateResult.thinkingLevel,
		baseline,
		candidate: evaluated,
		gatePassed: reasons.length === 0,
		reasons,
		warnings,
		createdAt: now.toISOString(),
	};
}

function findCandidate(
	candidates: readonly EvolutionCandidate[],
	candidateId: string,
	scope: EvolutionProjectScope,
): EvolutionCandidate {
	const candidate = candidates.find((item) => item.id === candidateId && sameProject(item.scope, scope));
	if (!candidate) throw new Error(`找不到改进候选 ${candidateId}`);
	if (!candidateChainIntegrity(candidates, candidate)) throw new Error("候选内容摘要校验失败，已拒绝使用");
	return candidate;
}

function candidateChain(
	candidates: readonly EvolutionCandidate[],
	candidate: EvolutionCandidate,
): EvolutionCandidate[] {
	const chain: EvolutionCandidate[] = [];
	const visited = new Set<string>();
	let current: EvolutionCandidate | undefined = candidate;
	while (current && chain.length < MAX_PROMPT_CHAIN && !visited.has(current.id)) {
		visited.add(current.id);
		chain.unshift(current);
		current = current.parentId ? candidates.find((item) => item.id === current?.parentId) : undefined;
	}
	return chain;
}

function candidateChainIntegrity(candidates: readonly EvolutionCandidate[], candidate: EvolutionCandidate): boolean {
	const chain = candidateChain(candidates, candidate);
	for (let index = 0; index < chain.length; index++) {
		const item = chain[index];
		if (!item) return false;
		const parent = chain[index - 1];
		if (item.parentId !== parent?.id) return false;
		if (candidateDigest(draftFromCandidate(item), item.scope, item.sourceSignalId, parent) !== item.digest)
			return false;
	}
	return chain.at(-1)?.id === candidate.id;
}

function candidateApplies(candidate: EvolutionCandidate, prompt: string, force: boolean): boolean {
	if (force || candidate.kind === "prompt") return true;
	const query = canonical(prompt);
	return candidate.triggerTerms.some((term) => query.includes(canonical(term)));
}

function renderPrompt(
	candidates: readonly EvolutionCandidate[],
	prompt: string,
	forceIds = new Set<string>(),
): string | undefined {
	const applied = candidates.filter((candidate) => candidateApplies(candidate, prompt, forceIds.has(candidate.id)));
	if (applied.length === 0) return undefined;
	return [
		"[Pi-go validated project learning]",
		"These rules were evaluated and approved by the user. Current user requests, project instructions, code, tests, and safety policy take priority.",
		...applied.map((candidate) => `- ${candidate.instruction}`),
	].join("\n");
}

export function promptContextFromSnapshot(snapshot: EvolutionSnapshot, prompt: string): EvolutionPromptContext {
	if (!snapshot.settings.enabled) return { appliedCandidateIds: [] };
	const stable = [...snapshot.candidates].reverse().find((candidate) => candidate.status === "promoted");
	const canary = [...snapshot.candidates].reverse().find((candidate) => candidate.status === "canary");
	const target = canary ?? stable;
	if (!target || !candidateChainIntegrity(snapshot.candidates, target)) return { appliedCandidateIds: [] };
	const chain = candidateChain(snapshot.candidates, target).filter((candidate) =>
		candidateApplies(candidate, prompt, false),
	);
	const systemPrompt = renderPrompt(chain, prompt);
	const canaryApplied = canary ? chain.some((candidate) => candidate.id === canary.id) : false;
	return {
		...(systemPrompt ? { systemPrompt } : {}),
		appliedCandidateIds: chain.map((candidate) => candidate.id),
		...(canaryApplied && canary ? { canaryCandidateId: canary.id } : {}),
	};
}

export class EvolutionStore {
	private readonly backend: EvolutionBackend;
	private readonly now: () => Date;

	constructor(
		storage: AuthStorageBackend = new FileAuthStorageBackend(path.join(getAgentDir(), "learning", "evolution.json")),
		now: () => Date = () => new Date(),
	) {
		this.backend = new LockedJsonEvolutionBackend(storage);
		this.now = now;
	}

	async snapshot(scope: EvolutionProjectScope): Promise<EvolutionSnapshot> {
		return this.backend.transact(async (store) => ({
			result: (() => {
				const signals = store.signals.filter((signal) => sameProject(signal.scope, scope));
				const candidates = store.candidates.filter((candidate) => sameProject(candidate.scope, scope));
				const subjectIds = new Set([
					...signals.map((signal) => signal.id),
					...candidates.map((candidate) => candidate.id),
				]);
				return {
					revision: store.revision,
					settings: structuredClone(store.settings),
					signals: signals.map((signal) => structuredClone(signal)),
					candidates: candidates.map((candidate) => structuredClone(candidate)),
					events: store.events
						.filter((event) => subjectIds.has(event.subjectId))
						.map((event) => structuredClone(event)),
				};
			})(),
		}));
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await this.backend.transact(async (store) => {
			if (store.settings.enabled === enabled) return { result: undefined };
			store.settings.enabled = enabled;
			store.revision += 1;
			return { result: undefined, changed: true };
		});
	}

	async observeRun(
		scope: EvolutionProjectScope,
		record: RunRecord,
	): Promise<{ signal?: EvolutionSignal; becameEligible: boolean }> {
		const outcome = signalOutcome(record);
		if (!outcome) return { becameEligible: false };
		const toolErrors = failedTools(record);
		const fingerprints = errorFingerprints(record);
		const fingerprint = signalFingerprint(record, outcome, toolErrors);
		return this.backend.transact<{ signal?: EvolutionSignal; becameEligible: boolean }>(async (store) => {
			if (!store.settings.enabled) return { result: { becameEligible: false } };
			const timestamp = this.now();
			const existing = store.signals.find(
				(signal) => signal.fingerprint === fingerprint && sameProject(signal.scope, scope),
			);
			if (existing) {
				existing.occurrences += 1;
				existing.lastSeenAt = timestamp.toISOString();
				existing.retries = Math.max(existing.retries, record.retries);
				existing.errorFingerprints = [...new Set([...existing.errorFingerprints, ...fingerprints])].slice(-20);
				existing.sourceRunIds = [...existing.sourceRunIds, record.id].slice(-SIGNAL_RUN_IDS);
				let becameEligible = false;
				if (existing.status === "observing" && existing.occurrences >= store.settings.signalThreshold) {
					existing.status = "eligible";
					becameEligible = true;
					addEvent(store, "signal_eligible", existing.id, timestamp, undefined, existing.fingerprint);
				} else addEvent(store, "signal_observed", existing.id, timestamp, undefined, existing.fingerprint);
				store.revision += 1;
				return { result: { signal: structuredClone(existing), becameEligible }, changed: true };
			}
			const signal: EvolutionSignal = {
				id: id("es"),
				fingerprint,
				scope: structuredClone(scope),
				status: store.settings.signalThreshold <= 1 ? "eligible" : "observing",
				occurrences: 1,
				sourceRunIds: [record.id],
				taskKind: record.taskKind,
				outcome,
				toolErrors,
				errorFingerprints: fingerprints,
				retries: record.retries,
				verification: record.evidence.verification,
				firstSeenAt: timestamp.toISOString(),
				lastSeenAt: timestamp.toISOString(),
			};
			store.signals.push(signal);
			addEvent(store, signal.status === "eligible" ? "signal_eligible" : "signal_observed", signal.id, timestamp);
			store.revision += 1;
			return {
				result: { signal: structuredClone(signal), becameEligible: signal.status === "eligible" },
				changed: true,
			};
		});
	}

	async suppressSignal(signalId: string, scope: EvolutionProjectScope): Promise<EvolutionSignal> {
		return this.backend.transact(async (store) => {
			const signal = store.signals.find((item) => item.id === signalId && sameProject(item.scope, scope));
			if (!signal) throw new Error(`找不到学习信号 ${signalId}`);
			signal.status = "suppressed";
			addEvent(store, "signal_suppressed", signal.id, this.now());
			store.revision += 1;
			return { result: structuredClone(signal), changed: true };
		});
	}

	async propose(
		signalId: string,
		draft: EvolutionCandidateDraft,
		scope: EvolutionProjectScope,
	): Promise<EvolutionCandidate> {
		const normalized = normalizedDraft(draft);
		const protectedText = Object.values(normalized).flat().join("\n");
		if (containsSensitiveCredential(protectedText)) throw new Error("候选中疑似包含敏感凭据，已拒绝保存");
		if (containsAuthorityDirective(protectedText)) throw new Error("候选不能修改工具权限、审批或安全策略");
		if (containsUnsafeCandidateDirective(protectedText)) {
			throw new Error("候选不能访问凭据、联网、安装依赖、增加工具能力或覆盖用户指令");
		}
		return this.backend.transact(async (store) => {
			const signal = store.signals.find((item) => item.id === signalId && sameProject(item.scope, scope));
			if (!signal) throw new Error(`找不到学习信号 ${signalId}`);
			if (signal.status !== "eligible") throw new Error(`该信号当前不能创建候选：${signal.status}`);
			if (store.candidates.length >= MAX_EVOLUTION_CANDIDATES) {
				throw new Error(`改进候选已达到 ${MAX_EVOLUTION_CANDIDATES} 条上限`);
			}
			const parent = [...store.candidates]
				.reverse()
				.find((candidate) => sameProject(candidate.scope, scope) && candidate.status === "promoted");
			if (parent && candidateChain(store.candidates, parent).length >= MAX_PROMPT_CHAIN) {
				throw new Error(`候选谱系已达到 ${MAX_PROMPT_CHAIN} 层，请先整理稳定规则`);
			}
			if (parent && !candidateChainIntegrity(store.candidates, parent)) {
				throw new Error("上一稳定候选摘要校验失败，不能创建子候选");
			}
			const digest = candidateDigest(normalized, scope, signal.id, parent);
			const duplicate = store.candidates.find((candidate) => candidate.digest === digest);
			if (duplicate) return { result: structuredClone(duplicate) };
			const timestamp = this.now();
			const candidate: EvolutionCandidate = {
				id: id("ec"),
				scope: structuredClone(scope),
				sourceSignalId: signal.id,
				...(parent ? { parentId: parent.id } : {}),
				...normalized,
				digest,
				status: "proposed",
				evaluations: [],
				revision: 1,
				createdAt: timestamp.toISOString(),
				updatedAt: timestamp.toISOString(),
			};
			signal.status = "linked";
			signal.candidateId = candidate.id;
			store.candidates.push(candidate);
			addEvent(store, "candidate_proposed", candidate.id, timestamp, digest, signal.id);
			store.revision += 1;
			return { result: structuredClone(candidate), changed: true };
		});
	}

	async saveEvaluation(
		candidateId: string,
		expectedDigest: string,
		baselineResult: AgentEvalResult,
		candidateResult: AgentEvalResult,
		scope: EvolutionProjectScope,
	): Promise<EvolutionCandidate> {
		return this.backend.transact(async (store) => {
			const candidate = findCandidate(store.candidates, candidateId, scope);
			if (candidate.digest !== expectedDigest) throw new Error("候选内容已变化，评测结果不能绑定");
			if (!new Set(["proposed", "evaluated", "failed"]).has(candidate.status)) {
				throw new Error(`该候选当前不能评测：${candidate.status}`);
			}
			const timestamp = this.now();
			const evaluation = evaluationFor(candidate, baselineResult, candidateResult, timestamp);
			candidate.evaluations = [...candidate.evaluations, evaluation].slice(-MAX_CANDIDATE_EVALUATIONS);
			candidate.status = evaluation.gatePassed ? "evaluated" : "failed";
			candidate.updatedAt = timestamp.toISOString();
			candidate.revision += 1;
			addEvent(
				store,
				"candidate_evaluated",
				candidate.id,
				timestamp,
				candidate.digest,
				evaluation.gatePassed ? "passed" : "failed",
			);
			store.revision += 1;
			return { result: structuredClone(candidate), changed: true };
		});
	}

	async reject(
		candidateId: string,
		expectedDigest: string,
		scope: EvolutionProjectScope,
	): Promise<EvolutionCandidate> {
		return this.backend.transact(async (store) => {
			const candidate = findCandidate(store.candidates, candidateId, scope);
			if (candidate.digest !== expectedDigest) throw new Error("候选内容已变化，请重新查看");
			if (!new Set(["proposed", "evaluated", "failed", "awaiting_promotion"]).has(candidate.status)) {
				throw new Error(`该候选当前不能拒绝：${candidate.status}`);
			}
			const timestamp = this.now();
			candidate.status = "rejected";
			candidate.endedAt = timestamp.toISOString();
			candidate.updatedAt = timestamp.toISOString();
			candidate.revision += 1;
			addEvent(store, "candidate_rejected", candidate.id, timestamp, candidate.digest);
			store.revision += 1;
			return { result: structuredClone(candidate), changed: true };
		});
	}

	async startCanary(
		candidateId: string,
		expectedDigest: string,
		scope: EvolutionProjectScope,
	): Promise<EvolutionCandidate> {
		return this.backend.transact(async (store) => {
			const candidate = findCandidate(store.candidates, candidateId, scope);
			if (candidate.digest !== expectedDigest) throw new Error("候选内容已变化，不能灰度");
			const evaluation = candidate.evaluations.at(-1);
			if (
				candidate.status !== "evaluated" ||
				evaluation?.gatePassed !== true ||
				evaluation.candidateDigest !== candidate.digest
			) {
				throw new Error("候选必须先通过 A/B 评测");
			}
			const activeCanary = store.candidates.find(
				(item) => sameProject(item.scope, scope) && item.status === "canary",
			);
			if (activeCanary) throw new Error(`已有灰度候选：${activeCanary.id}`);
			const stable = [...store.candidates]
				.reverse()
				.find((item) => sameProject(item.scope, scope) && item.status === "promoted");
			if (candidate.parentId !== stable?.id) throw new Error("稳定基线已经变化，请基于当前版本重新提出候选");
			const timestamp = this.now();
			candidate.status = "canary";
			candidate.approval = { candidateDigest: candidate.digest, approvedAt: timestamp.toISOString() };
			candidate.canary = {
				candidateDigest: candidate.digest,
				totalRuns: store.settings.canaryRuns,
				remainingRuns: store.settings.canaryRuns,
				successfulRuns: 0,
				startedAt: timestamp.toISOString(),
				...(stable ? { previousStableId: stable.id } : {}),
			};
			candidate.updatedAt = timestamp.toISOString();
			candidate.revision += 1;
			addEvent(store, "canary_started", candidate.id, timestamp, candidate.digest);
			store.revision += 1;
			return { result: structuredClone(candidate), changed: true };
		});
	}

	async recordCanaryRun(
		candidateId: string,
		record: RunRecord,
		scope: EvolutionProjectScope,
	): Promise<CanaryRunOutcome> {
		return this.backend.transact<CanaryRunOutcome>(async (store) => {
			const candidate = findCandidate(store.candidates, candidateId, scope);
			if (candidate.status !== "canary" || !candidate.canary) return { result: { action: "none" } };
			if (candidate.canary.candidateDigest !== candidate.digest) throw new Error("灰度候选摘要不一致，已停止计数");
			const timestamp = this.now();
			candidate.canary.lastRunId = record.id;
			const failed =
				record.outcome === "failed" ||
				record.outcome === "unverified" ||
				record.evidence.verification === "failed" ||
				failedTools(record).length > 0;
			if (failed) {
				candidate.status = "rolled_back";
				candidate.endedAt = timestamp.toISOString();
				candidate.updatedAt = timestamp.toISOString();
				candidate.revision += 1;
				addEvent(store, "candidate_rolled_back", candidate.id, timestamp, candidate.digest, record.id);
				store.revision += 1;
				return {
					result: { action: "rolled_back", candidate: structuredClone(candidate) },
					changed: true,
				};
			}
			candidate.canary.successfulRuns += 1;
			candidate.canary.remainingRuns = Math.max(0, candidate.canary.remainingRuns - 1);
			candidate.updatedAt = timestamp.toISOString();
			candidate.revision += 1;
			if (candidate.canary.remainingRuns === 0) {
				candidate.status = "awaiting_promotion";
				addEvent(store, "canary_passed", candidate.id, timestamp, candidate.digest);
				store.revision += 1;
				return {
					result: { action: "awaiting_promotion", candidate: structuredClone(candidate) },
					changed: true,
				};
			}
			store.revision += 1;
			return { result: { action: "continued", candidate: structuredClone(candidate) }, changed: true };
		});
	}

	async promote(
		candidateId: string,
		expectedDigest: string,
		scope: EvolutionProjectScope,
	): Promise<EvolutionCandidate> {
		return this.backend.transact(async (store) => {
			const candidate = findCandidate(store.candidates, candidateId, scope);
			if (
				candidate.digest !== expectedDigest ||
				candidate.approval?.candidateDigest !== expectedDigest ||
				candidate.evaluations.at(-1)?.candidateDigest !== expectedDigest ||
				candidate.canary?.candidateDigest !== expectedDigest
			) {
				throw new Error("候选、评测或批准摘要不一致，不能启用");
			}
			if (candidate.status !== "awaiting_promotion" || !candidate.canary || candidate.canary.remainingRuns !== 0) {
				throw new Error("候选尚未完成灰度");
			}
			const timestamp = this.now();
			for (const item of store.candidates) {
				if (item.id === candidate.id || !sameProject(item.scope, scope) || item.status !== "promoted") continue;
				item.status = "superseded";
				item.endedAt = timestamp.toISOString();
				item.updatedAt = timestamp.toISOString();
				item.revision += 1;
			}
			candidate.status = "promoted";
			candidate.promotedAt = timestamp.toISOString();
			candidate.updatedAt = timestamp.toISOString();
			candidate.revision += 1;
			addEvent(store, "candidate_promoted", candidate.id, timestamp, candidate.digest);
			store.revision += 1;
			return { result: structuredClone(candidate), changed: true };
		});
	}

	async rollback(candidateId: string, scope: EvolutionProjectScope): Promise<EvolutionCandidate> {
		return this.backend.transact(async (store) => {
			const candidate = findCandidate(store.candidates, candidateId, scope);
			if (!new Set(["canary", "awaiting_promotion", "promoted"]).has(candidate.status)) {
				throw new Error(`该候选当前不能回滚：${candidate.status}`);
			}
			const timestamp = this.now();
			const previousStableId = candidate.canary?.previousStableId ?? candidate.parentId;
			candidate.status = "rolled_back";
			candidate.endedAt = timestamp.toISOString();
			candidate.updatedAt = timestamp.toISOString();
			candidate.revision += 1;
			if (previousStableId) {
				const previous = store.candidates.find((item) => item.id === previousStableId);
				if (previous?.status === "superseded") {
					previous.status = "promoted";
					delete previous.endedAt;
					previous.updatedAt = timestamp.toISOString();
					previous.revision += 1;
				}
			}
			addEvent(store, "candidate_rolled_back", candidate.id, timestamp, candidate.digest, "manual");
			store.revision += 1;
			return { result: structuredClone(candidate), changed: true };
		});
	}

	async promptContext(scope: EvolutionProjectScope, prompt: string): Promise<EvolutionPromptContext> {
		return this.backend.transact(async (store) => {
			const candidates = store.candidates
				.filter((candidate) => sameProject(candidate.scope, scope))
				.map((candidate) => structuredClone(candidate));
			return {
				result: promptContextFromSnapshot(
					{
						revision: store.revision,
						settings: structuredClone(store.settings),
						signals: [],
						candidates,
						events: [],
					},
					prompt,
				),
			};
		});
	}

	async evaluationPrompts(
		candidateId: string,
		scope: EvolutionProjectScope,
	): Promise<{ candidate: EvolutionCandidate; baselinePrompt?: string; candidatePrompt: string }> {
		return this.backend.transact(async (store) => {
			const candidate = findCandidate(store.candidates, candidateId, scope);
			const chain = candidateChain(store.candidates, candidate);
			const baselineChain = chain.filter((item) => item.id !== candidate.id);
			const baselinePrompt = renderPrompt(baselineChain, "", new Set(baselineChain.map((item) => item.id)));
			const candidatePrompt = renderPrompt(chain, "", new Set(chain.map((item) => item.id)));
			if (!candidatePrompt) throw new Error("候选提示为空，不能评测");
			return {
				result: {
					candidate: structuredClone(candidate),
					...(baselinePrompt ? { baselinePrompt } : {}),
					candidatePrompt,
				},
			};
		});
	}
}
