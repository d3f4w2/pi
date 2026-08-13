import { createHash } from "node:crypto";
import path from "node:path";
import type { VerifyOperation } from "../extensions/verify/types.ts";

const DEFAULT_RUN_TIMEOUT_SECONDS = 1800;
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_MAX_TOOL_CALLS = 200;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 60;
const MAX_TASK_LENGTH = 200_000;

const CONTRACT_KEYS = new Set(["version", "task", "scope", "verification", "budget"]);
const VERIFICATION_KEYS = new Set(["operation", "path", "timeoutSeconds"]);
const BUDGET_KEYS = new Set(["timeoutSeconds", "maxTokens", "maxToolCalls"]);
const VERIFY_OPERATIONS = new Set<VerifyOperation>(["auto", "typecheck", "test", "lint"]);

export interface RunVerificationContract {
	operation: VerifyOperation;
	path: string;
	timeoutSeconds: number;
}

export interface RunBudgetContract {
	timeoutSeconds: number;
	maxTokens: number;
	maxToolCalls: number;
}

export interface EffectiveRunContract {
	version: 1;
	task: string;
	scope: string[];
	verification: RunVerificationContract[];
	budget: RunBudgetContract;
}

export interface RunContractDocument {
	version: 1;
	task: string;
	scope?: string[];
	verification?: RunVerificationContract[];
	budget?: Partial<RunBudgetContract>;
}

export interface ParsedRunArguments {
	help: boolean;
	json: boolean;
	task?: string;
	contractPath?: string;
	checkReceiptPath?: string;
	receiptPath?: string;
	scope?: string[];
	verification?: RunVerificationContract[];
	timeoutSeconds?: number;
	maxTokens?: number;
	maxToolCalls?: number;
	forwardedArgs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} 包含未知字段 "${key}"。`);
	}
}

function requiredString(value: unknown, label: string, maxLength = 4096): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} 必须是非空字符串。`);
	const normalized = value.trim();
	if (normalized.length > maxLength) throw new Error(`${label} 超过 ${maxLength} 个字符。`);
	return normalized;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
	}
	return value;
}

function parseIntegerOption(value: string, option: string, minimum: number, maximum: number): number {
	if (!/^\d+$/.test(value)) throw new Error(`${option} 必须是整数。`);
	return boundedInteger(Number(value), option, minimum, maximum);
}

function parseVerifyOperation(value: unknown, label: string): VerifyOperation {
	if (typeof value !== "string" || !VERIFY_OPERATIONS.has(value as VerifyOperation)) {
		throw new Error(`${label} 必须是 auto、typecheck、test 或 lint。`);
	}
	return value as VerifyOperation;
}

function parseVerificationDocument(value: unknown, index: number): RunVerificationContract {
	if (!isRecord(value)) throw new Error(`verification[${index}] 必须是对象。`);
	assertKnownKeys(value, VERIFICATION_KEYS, `verification[${index}]`);
	return {
		operation: parseVerifyOperation(value.operation, `verification[${index}].operation`),
		path: requiredString(value.path ?? ".", `verification[${index}].path`),
		timeoutSeconds: boundedInteger(
			value.timeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS,
			`verification[${index}].timeoutSeconds`,
			5,
			300,
		),
	};
}

function parseBudgetDocument(value: unknown): Partial<RunBudgetContract> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("budget 必须是对象。");
	assertKnownKeys(value, BUDGET_KEYS, "budget");
	return {
		...(value.timeoutSeconds === undefined
			? {}
			: { timeoutSeconds: boundedInteger(value.timeoutSeconds, "budget.timeoutSeconds", 1, 86_400) }),
		...(value.maxTokens === undefined
			? {}
			: { maxTokens: boundedInteger(value.maxTokens, "budget.maxTokens", 1, 10_000_000) }),
		...(value.maxToolCalls === undefined
			? {}
			: { maxToolCalls: boundedInteger(value.maxToolCalls, "budget.maxToolCalls", 1, 10_000) }),
	};
}

export function parseRunContractText(text: string): RunContractDocument {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`执行契约不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value)) throw new Error("执行契约必须是 JSON 对象。");
	assertKnownKeys(value, CONTRACT_KEYS, "执行契约");
	if (value.version !== 1) throw new Error("执行契约 version 必须是 1。");

	let scope: string[] | undefined;
	if (value.scope !== undefined) {
		if (!Array.isArray(value.scope)) throw new Error("scope 必须是字符串数组。");
		scope = value.scope.map((entry, index) => requiredString(entry, `scope[${index}]`));
	}

	let verification: RunVerificationContract[] | undefined;
	if (value.verification !== undefined) {
		if (!Array.isArray(value.verification)) throw new Error("verification 必须是数组。");
		verification = value.verification.map(parseVerificationDocument);
	}
	const budget = parseBudgetDocument(value.budget);

	return {
		version: 1,
		task: requiredString(value.task, "task", MAX_TASK_LENGTH),
		...(scope === undefined ? {} : { scope }),
		...(verification === undefined ? {} : { verification }),
		...(budget === undefined ? {} : { budget }),
	};
}

function optionValue(args: readonly string[], index: number, inlineValue: string | undefined, option: string): string {
	if (inlineValue !== undefined) {
		if (inlineValue.length === 0) throw new Error(`${option} 缺少值。`);
		return inlineValue;
	}
	const next = args[index + 1];
	if (next === undefined || next === "--") throw new Error(`${option} 缺少值。`);
	return next;
}

function parseVerificationOption(value: string): RunVerificationContract | "none" {
	if (value === "none") return "none";
	const separator = value.indexOf(":");
	const operationText = separator === -1 ? value : value.slice(0, separator);
	const verifyPath = separator === -1 ? "." : requiredString(value.slice(separator + 1), "--verify path");
	return {
		operation: parseVerifyOperation(operationText, "--verify"),
		path: verifyPath,
		timeoutSeconds: DEFAULT_VERIFY_TIMEOUT_SECONDS,
	};
}

function validateForwardedArguments(args: readonly string[]): void {
	const exactForbidden = new Set([
		"--mode",
		"--print",
		"-p",
		"--session",
		"--continue",
		"-c",
		"--resume",
		"-r",
		"--no-session",
		"--rpc",
		"--acp",
	]);
	const prefixForbidden = ["--mode=", "--session=", "--print="];
	const forbidden = args.find(
		(argument) => exactForbidden.has(argument) || prefixForbidden.some((prefix) => argument.startsWith(prefix)),
	);
	if (forbidden) throw new Error(`不能把 ${forbidden} 转发给受控 Agent 进程。`);
}

export function parseRunArguments(args: readonly string[]): ParsedRunArguments {
	const taskParts: string[] = [];
	const scopes: string[] = [];
	const verifications: RunVerificationContract[] = [];
	let verificationDisabled = false;
	let help = false;
	let json = false;
	let contractPath: string | undefined;
	let checkReceiptPath: string | undefined;
	let receiptPath: string | undefined;
	let timeoutSeconds: number | undefined;
	let maxTokens: number | undefined;
	let maxToolCalls: number | undefined;
	let forwardedArgs: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			forwardedArgs = args.slice(index + 1);
			validateForwardedArguments(forwardedArgs);
			break;
		}
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (!argument.startsWith("-")) {
			taskParts.push(argument);
			continue;
		}

		const equals = argument.indexOf("=");
		const option = equals === -1 ? argument : argument.slice(0, equals);
		const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
		if (option === "--json") {
			if (inlineValue !== undefined) throw new Error("--json 不接受值。");
			json = true;
			continue;
		}
		if (
			option === "--contract" ||
			option === "--receipt" ||
			option === "--check-receipt" ||
			option === "--scope" ||
			option === "--verify"
		) {
			const value = optionValue(args, index, inlineValue, option);
			if (inlineValue === undefined) index += 1;
			if (option === "--contract") contractPath = requiredString(value, option);
			if (option === "--receipt") receiptPath = requiredString(value, option);
			if (option === "--check-receipt") checkReceiptPath = requiredString(value, option);
			if (option === "--scope") scopes.push(requiredString(value, option));
			if (option === "--verify") {
				const verification = parseVerificationOption(value);
				if (verification === "none") verificationDisabled = true;
				else verifications.push(verification);
			}
			continue;
		}
		if (option === "--timeout" || option === "--max-tokens" || option === "--max-tool-calls") {
			const value = optionValue(args, index, inlineValue, option);
			if (inlineValue === undefined) index += 1;
			if (option === "--timeout") timeoutSeconds = parseIntegerOption(value, option, 1, 86_400);
			if (option === "--max-tokens") maxTokens = parseIntegerOption(value, option, 1, 10_000_000);
			if (option === "--max-tool-calls") maxToolCalls = parseIntegerOption(value, option, 1, 10_000);
			continue;
		}
		throw new Error(`未知选项 "${option}"。`);
	}

	if (verificationDisabled && verifications.length > 0) throw new Error("--verify none 不能与其他验证项同时使用。");
	const task = taskParts.join(" ").trim() || undefined;
	if (contractPath && task) throw new Error("不能同时提供位置任务和 --contract。");
	if (
		checkReceiptPath &&
		(task ||
			contractPath ||
			receiptPath ||
			scopes.length > 0 ||
			verifications.length > 0 ||
			verificationDisabled ||
			forwardedArgs.length > 0)
	) {
		throw new Error("--check-receipt 不能与执行任务的参数同时使用。");
	}

	return {
		help,
		json,
		...(task === undefined ? {} : { task }),
		...(contractPath === undefined ? {} : { contractPath }),
		...(checkReceiptPath === undefined ? {} : { checkReceiptPath }),
		...(receiptPath === undefined ? {} : { receiptPath }),
		...(scopes.length === 0 ? {} : { scope: scopes }),
		...(verificationDisabled
			? { verification: [] }
			: verifications.length === 0
				? {}
				: { verification: verifications }),
		...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(maxToolCalls === undefined ? {} : { maxToolCalls }),
		forwardedArgs,
	};
}

function normalizeWorkspacePath(value: string, workspaceRoot: string, label: string): string {
	const absolute = path.resolve(workspaceRoot, value);
	const relative = path.relative(workspaceRoot, absolute);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`${label} 必须位于 Git 工作区内。`);
	}
	return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

export function createEffectiveRunContract(
	arguments_: ParsedRunArguments,
	document: RunContractDocument | undefined,
	workspaceRoot: string,
): EffectiveRunContract {
	if (arguments_.contractPath && !document) throw new Error(`无法读取执行契约 ${arguments_.contractPath}。`);
	const task = arguments_.task ?? document?.task;
	if (!task) throw new Error("请提供任务文本或 --contract。");

	const rawScope = arguments_.scope ?? document?.scope ?? ["."];
	const rawVerification = arguments_.verification ??
		document?.verification ?? [
			{ operation: "auto" as const, path: ".", timeoutSeconds: DEFAULT_VERIFY_TIMEOUT_SECONDS },
		];
	const documentBudget = document?.budget;

	return {
		version: 1,
		task: requiredString(task, "task", MAX_TASK_LENGTH),
		scope: unique(rawScope.map((entry, index) => normalizeWorkspacePath(entry, workspaceRoot, `scope[${index}]`))),
		verification: rawVerification.map((entry, index) => ({
			operation: entry.operation,
			path: normalizeWorkspacePath(entry.path, workspaceRoot, `verification[${index}].path`),
			timeoutSeconds: entry.timeoutSeconds,
		})),
		budget: {
			timeoutSeconds: arguments_.timeoutSeconds ?? documentBudget?.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS,
			maxTokens: arguments_.maxTokens ?? documentBudget?.maxTokens ?? DEFAULT_MAX_TOKENS,
			maxToolCalls: arguments_.maxToolCalls ?? documentBudget?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
		},
	};
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("不能序列化非有限数值。");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	throw new Error("只能序列化 JSON 值。");
}

export function hashRunContract(contract: EffectiveRunContract): string {
	return createHash("sha256").update(canonicalJson(contract)).digest("hex");
}
