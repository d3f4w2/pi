import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type {
	ToolApproval,
	ToolApprovalDecision,
	ToolApprovalPolicy,
	ToolApprovalTier,
} from "@earendil-works/pi-agent-core";
import type { ToolApprovalMode, ToolApprovalSetting } from "./settings-manager.ts";

const READ_TOOLS = new Set([
	"ast_grep",
	"code_search",
	"find",
	"grep",
	"ls",
	"read",
	"tool_search",
	"web_fetch",
	"web_search",
]);
const WRITE_TOOLS = new Set(["edit", "todo", "write"]);
const READ_ONLY_LSP_ACTIONS = new Set([
	"definition",
	"diagnostics",
	"hover",
	"implementation",
	"references",
	"symbols",
	"workspace_symbols",
]);
const MAX_DETAIL_CHARACTERS = 2_000;
const MAX_FINGERPRINT_CHARACTERS = 16_000;

export interface ToolApprovalSource {
	name: string;
	approval?: ToolApproval;
	formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
}

export interface ToolApprovalEvaluation {
	action: "allow" | "deny" | "prompt";
	tier: ToolApprovalTier;
	reason?: string;
	details: string[];
	fingerprint: string;
}

export const TOOL_APPROVAL_DECISION_ENTRY_TYPE = "pi.tool-approval-decision.v1";

export interface ToolApprovalDecisionRecord {
	version: 1;
	toolCallId: string;
	toolName: string;
	tier: ToolApprovalTier;
	choice: "allow-once" | "allow-session" | "allow-always" | "deny-always" | "reject-once";
	outcome: "allow" | "deny";
	reason?: string;
	details: string[];
}

export interface EvaluateToolApprovalOptions {
	tool: ToolApprovalSource;
	args: unknown;
	cwd: string;
	settings: {
		mode: ToolApprovalMode;
		policies: Readonly<Record<string, ToolApprovalSetting>>;
	};
	canPrompt: boolean;
	approvedFingerprints?: ReadonlySet<string>;
}

interface NormalizedDecision {
	tier: ToolApprovalTier;
	policy?: ToolApprovalPolicy;
	override: boolean;
	reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTier(value: unknown): value is ToolApprovalTier {
	return value === "read" || value === "write" || value === "exec";
}

function isPolicy(value: unknown): value is ToolApprovalPolicy {
	return value === "allow" || value === "deny" || value === "prompt";
}

function inferredTier(toolName: string, args: unknown): ToolApprovalTier {
	const name = toolName.toLowerCase();
	if (READ_TOOLS.has(name)) return "read";
	if (WRITE_TOOLS.has(name)) return "write";
	if (name === "lsp" && isRecord(args)) {
		const operation = typeof args.operation === "string" ? args.operation : args.action;
		if (typeof operation === "string") return READ_ONLY_LSP_ACTIONS.has(operation.toLowerCase()) ? "read" : "write";
	}
	return "exec";
}

function normalizeDecision(tool: ToolApprovalSource, args: unknown): NormalizedDecision {
	let value: ToolApprovalDecision | undefined;
	try {
		value = typeof tool.approval === "function" ? tool.approval(args) : tool.approval;
	} catch {
		return { tier: "exec", policy: "prompt", override: true, reason: "工具无法安全判断本次操作" };
	}
	if (value === undefined) return { tier: inferredTier(tool.name, args), override: false };
	if (isTier(value)) return { tier: value, override: false };
	if (!isRecord(value) || !isTier(value.tier)) {
		return { tier: "exec", policy: "prompt", override: true, reason: "工具返回了无效的安全级别" };
	}
	return {
		tier: value.tier,
		override: value.override === true,
		...(isPolicy(value.policy) ? { policy: value.policy } : {}),
		...(typeof value.reason === "string" && value.reason.trim() ? { reason: value.reason.trim() } : {}),
	};
}

/** Return the conservative base tier used by compact tool-management UIs. */
export function getToolApprovalTier(tool: ToolApprovalSource): ToolApprovalTier {
	return normalizeDecision(tool, {}).tier;
}

function redact(value: string): string {
	return value
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [已隐藏]")
		.replace(/\bsk-[a-z0-9_-]{8,}/gi, "[已隐藏]")
		.replace(/\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[已隐藏]@")
		.replace(/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[=:]\s*["']?)[^"'\s,;}]+/gi, "$1[已隐藏]")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function cap(value: string, maximum: number): string {
	const characters = Array.from(value);
	return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`;
}

function approvalDetails(tool: ToolApprovalSource, args: unknown): string[] {
	let formatted: string | string[] | undefined;
	try {
		formatted = tool.formatApprovalDetails?.(args);
	} catch {
		formatted = undefined;
	}
	if (formatted === undefined && isRecord(args)) {
		if (typeof args.command === "string") formatted = `命令：${args.command}`;
		else if (typeof args.path === "string") formatted = `路径：${args.path}`;
	}
	const values = typeof formatted === "string" ? [formatted] : (formatted ?? []);
	let remaining = MAX_DETAIL_CHARACTERS;
	const details: string[] = [];
	for (const value of values) {
		if (remaining <= 0) break;
		const safe = cap(redact(value), remaining);
		if (!safe) continue;
		details.push(safe);
		remaining -= Array.from(safe).length;
	}
	return details;
}

function isCriticalCommand(command: string): boolean {
	const normalized = command.replace(/\s+/g, " ").trim();
	return [
		/\bgit\s+reset\s+--hard\b/i,
		/\bgit\s+clean\b[^\n;&|]*\s-[a-z]*f/i,
		/\bgit\s+push\b[^\n;&|]*(?:--force\b|-f\b)/i,
		/\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b[^\n;&|]*(?:\s\/\s*$|\s~(?:\/|\s|$)|\$HOME)/i,
		/\b(?:shutdown|reboot|poweroff|halt)\b/i,
		/\b(?:Restart-Computer|Stop-Computer|Format-Volume|Clear-Disk)\b/i,
		/\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z|fi|)?sh\b/i,
		/\b(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^|]*\|\s*(?:iex|Invoke-Expression)\b/i,
		/:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,
	].some((pattern) => pattern.test(normalized));
}

function isOutsideWorkspace(cwd: string, target: string): boolean {
	const useWindowsPaths = win32.isAbsolute(cwd) || win32.isAbsolute(target);
	const pathApi = useWindowsPaths ? win32 : { isAbsolute, relative, resolve, sep };
	const workspace = pathApi.resolve(cwd);
	const destination = pathApi.resolve(cwd, target);
	const relation = pathApi.relative(workspace, destination);
	return relation === ".." || relation.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relation);
}

function criticalReason(
	tool: ToolApprovalSource,
	args: unknown,
	decision: NormalizedDecision,
	cwd: string,
): string | undefined {
	if (decision.override) return decision.reason ?? "工具标记了需要确认的高风险操作";
	if (!isRecord(args)) return undefined;
	if (tool.name.toLowerCase() === "bash" && typeof args.command === "string" && isCriticalCommand(args.command)) {
		return "检测到可能破坏数据或系统状态的危险命令";
	}
	if (
		decision.tier === "write" &&
		typeof args.path === "string" &&
		args.path.trim() !== "" &&
		isOutsideWorkspace(cwd, args.path)
	) {
		return "即将修改当前工作区外的文件";
	}
	return undefined;
}

interface SerializationBudget {
	remaining: number;
}

function consume(value: string, budget: SerializationBudget): string | undefined {
	if (value.length > budget.remaining) return undefined;
	budget.remaining -= value.length;
	return value;
}

function canonical(value: unknown, seen: Set<object>, budget: SerializationBudget): string | undefined {
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return consume(JSON.stringify(value), budget);
	}
	if (typeof value === "string") {
		if (value.length + 2 > budget.remaining) return undefined;
		return consume(JSON.stringify(value), budget);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) return undefined;
		seen.add(value);
		const items: string[] = [];
		if (consume("[", budget) === undefined) return undefined;
		for (const [index, valueItem] of value.entries()) {
			if (index > 0 && consume(",", budget) === undefined) return undefined;
			const item = canonical(valueItem, seen, budget);
			if (item === undefined) return undefined;
			items.push(item);
		}
		seen.delete(value);
		return consume("]", budget) === undefined ? undefined : `[${items.join(",")}]`;
	}
	if (!isRecord(value) || seen.has(value)) return undefined;
	seen.add(value);
	const fields: string[] = [];
	if (consume("{", budget) === undefined) return undefined;
	for (const [index, key] of Object.keys(value).sort().entries()) {
		if (index > 0 && consume(",", budget) === undefined) return undefined;
		const serializedKey = JSON.stringify(key);
		if (consume(serializedKey, budget) === undefined || consume(":", budget) === undefined) return undefined;
		const item = canonical(value[key], seen, budget);
		if (item === undefined) {
			seen.delete(value);
			return undefined;
		}
		fields.push(`${serializedKey}:${item}`);
	}
	seen.delete(value);
	return consume("}", budget) === undefined ? undefined : `{${fields.join(",")}}`;
}

function fingerprint(toolName: string, args: unknown): string {
	const serialized = canonical(args, new Set(), { remaining: MAX_FINGERPRINT_CHARACTERS });
	return serialized === undefined || serialized.length > MAX_FINGERPRINT_CHARACTERS
		? ""
		: `${toolName.toLowerCase()}:${serialized}`;
}

function modePrompts(mode: ToolApprovalMode, tier: ToolApprovalTier): boolean {
	return mode === "always-ask" ? true : mode === "write" ? tier !== "read" : false;
}

export function evaluateToolApproval(options: EvaluateToolApprovalOptions): ToolApprovalEvaluation {
	const decision = normalizeDecision(options.tool, options.args);
	const userPolicy = options.settings.policies[options.tool.name.toLowerCase()];
	const operationFingerprint = fingerprint(options.tool.name, options.args);
	const base = {
		tier: decision.tier,
		details: approvalDetails(options.tool, options.args),
		fingerprint: operationFingerprint,
	};
	if (decision.policy === "deny" || userPolicy === "deny") {
		return { ...base, action: "deny", reason: decision.reason ?? "该工具已被安全策略禁止" };
	}
	if (operationFingerprint && options.approvedFingerprints?.has(operationFingerprint)) {
		return { ...base, action: "allow" };
	}
	const safetyReason = criticalReason(options.tool, options.args, decision, options.cwd);
	const needsPrompt =
		safetyReason !== undefined ||
		decision.policy === "prompt" ||
		userPolicy === "prompt" ||
		(decision.policy !== "allow" && userPolicy !== "allow" && modePrompts(options.settings.mode, decision.tier));
	if (!needsPrompt) return { ...base, action: "allow" };
	const reason = safetyReason ?? decision.reason ?? "当前安全模式需要用户确认";
	return options.canPrompt
		? { ...base, action: "prompt", reason }
		: { ...base, action: "deny", reason: `${reason}，但当前没有可用的确认界面` };
}
