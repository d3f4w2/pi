import type { ToolResultEvent } from "../../core/extensions/types.ts";
import { detectLanguageAdapter } from "./languages.ts";
import type { LspToolRequest, LspToolResult } from "./types.ts";

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_DIAGNOSTICS = 20;
const DEFAULT_MAX_RESULTS_PER_FILE = 10;
const DEFAULT_MAX_FEEDBACK_ROUNDS = 2;
const DEFAULT_TIMEOUT_MS = 2_500;

export interface LspDiagnosticsService {
	warmup?(filePath: string, cwd: string, onStatus?: (message: string) => void): Promise<void>;
	execute(
		request: LspToolRequest,
		cwd: string,
		signal?: AbortSignal,
		onStatus?: (message: string) => void,
	): Promise<LspToolResult>;
}

export interface LspAutoDiagnosticsWarmupContext {
	cwd: string;
	onStatus?: (message: string) => void;
}

export interface LspAutoDiagnosticsOptions {
	maxFiles?: number;
	maxDiagnostics?: number;
	maxFeedbackRounds?: number;
	timeoutMs?: number;
}

export type LspAutoDiagnosticsResultKind = "idle" | "deferred" | "clean" | "diagnostics" | "skipped" | "limited";

export interface LspAutoDiagnosticsResult {
	kind: LspAutoDiagnosticsResultKind;
	checkedFiles: number;
	diagnosticCount: number;
	message?: string;
	notice?: string;
}

interface FileCheckSuccess {
	filePath: string;
	result: LspToolResult;
}

interface FileCheckFailure {
	filePath: string;
	error: string;
}

type FileCheck = FileCheckSuccess | FileCheckFailure;

interface WarmupState {
	status: "pending" | "ready" | "failed";
	deferred: boolean;
}

function changedFilesFromResult(event: ToolResultEvent): string[] {
	if (event.isError) return [];
	if (event.toolName === "edit" || event.toolName === "write") {
		return typeof event.input.path === "string" ? [event.input.path] : [];
	}
	if (event.toolName !== "lsp" || typeof event.details !== "object" || event.details === null) return [];
	const changedFiles = Reflect.get(event.details, "changedFiles");
	return Array.isArray(changedFiles)
		? changedFiles.filter((filePath): filePath is string => typeof filePath === "string")
		: [];
}

export class LspAutoDiagnostics {
	private readonly service: LspDiagnosticsService;
	private readonly maxFiles: number;
	private readonly maxDiagnostics: number;
	private readonly maxFeedbackRounds: number;
	private readonly timeoutMs: number;
	private readonly pendingFiles = new Set<string>();
	private readonly warmups = new Map<string, WarmupState>();
	private feedbackRounds = 0;
	private failureNoticeShown = false;
	private limitNoticeShown = false;

	constructor(service: LspDiagnosticsService, options: LspAutoDiagnosticsOptions = {}) {
		this.service = service;
		this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
		this.maxDiagnostics = Math.max(1, options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS);
		this.maxFeedbackRounds = Math.max(1, options.maxFeedbackRounds ?? DEFAULT_MAX_FEEDBACK_ROUNDS);
		this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	}

	get pendingFileCount(): number {
		return this.pendingFiles.size;
	}

	recordToolResult(event: ToolResultEvent, warmupContext?: LspAutoDiagnosticsWarmupContext): void {
		for (const filePath of changedFilesFromResult(event)) {
			this.pendingFiles.add(filePath);
			if (!warmupContext || !this.service.warmup || detectLanguageAdapter(filePath) === undefined) continue;
			const key = this.warmupKey(warmupContext.cwd, filePath);
			if (this.warmups.get(key)?.status === "pending") continue;
			const state: WarmupState = { status: "pending", deferred: false };
			this.warmups.set(key, state);
			void this.service.warmup(filePath, warmupContext.cwd, warmupContext.onStatus).then(
				() => {
					state.status = "ready";
				},
				() => {
					state.status = "failed";
				},
			);
		}
	}

	resetRun(): void {
		this.pendingFiles.clear();
		this.warmups.clear();
		this.feedbackRounds = 0;
		this.limitNoticeShown = false;
	}

	discardPending(): void {
		this.pendingFiles.clear();
		this.warmups.clear();
	}

	async flush(
		cwd: string,
		signal?: AbortSignal,
		onStatus?: (message: string) => void,
	): Promise<LspAutoDiagnosticsResult> {
		const files = [...this.pendingFiles]
			.filter((filePath) => detectLanguageAdapter(filePath) !== undefined)
			.slice(0, this.maxFiles);
		const newlyPendingWarmups = files
			.map((filePath) => this.warmups.get(this.warmupKey(cwd, filePath)))
			.filter((state): state is WarmupState => state?.status === "pending" && !state.deferred);
		if (newlyPendingWarmups.length > 0) {
			for (const state of newlyPendingWarmups) state.deferred = true;
			return { kind: "deferred", checkedFiles: 0, diagnosticCount: 0 };
		}
		this.pendingFiles.clear();
		for (const filePath of files) this.warmups.delete(this.warmupKey(cwd, filePath));
		if (files.length === 0) return { kind: "idle", checkedFiles: 0, diagnosticCount: 0 };

		if (this.feedbackRounds >= this.maxFeedbackRounds) {
			const notice = this.limitNoticeShown
				? undefined
				: `自动 LSP 修复已经达到 ${this.maxFeedbackRounds} 轮，后续自动检查已停止；需要时请手动运行诊断或测试。`;
			this.limitNoticeShown = true;
			return { kind: "limited", checkedFiles: 0, diagnosticCount: 0, ...(notice ? { notice } : {}) };
		}

		const controller = new AbortController();
		const abort = () => controller.abort();
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });

		const checks = Promise.all(
			files.map(async (filePath): Promise<FileCheck> => {
				try {
					let languageServerStarted = false;
					const reportStatus = (message: string): void => {
						languageServerStarted = true;
						onStatus?.(message);
					};
					let result = await this.service.execute(
						{ operation: "diagnostics", path: filePath, maxResults: DEFAULT_MAX_RESULTS_PER_FILE },
						cwd,
						controller.signal,
						reportStatus,
					);
					if (languageServerStarted && result.details.resultCount === 0) {
						result = await this.service.execute(
							{ operation: "diagnostics", path: filePath, maxResults: DEFAULT_MAX_RESULTS_PER_FILE },
							cwd,
							controller.signal,
							onStatus,
						);
					}
					return {
						filePath,
						result,
					};
				} catch (error) {
					return { filePath, error: error instanceof Error ? error.message : String(error) };
				}
			}),
		);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutResult = new Promise<"timeout">((resolve) => {
			timeout = setTimeout(() => resolve("timeout"), this.timeoutMs);
		});

		try {
			const outcome = await Promise.race([checks, timeoutResult]);
			if (outcome === "timeout") {
				controller.abort();
				return {
					kind: "skipped",
					checkedFiles: 0,
					diagnosticCount: 0,
					...this.failureNotice(`自动 LSP 检查超时（${this.timeoutMs}ms），已跳过，不影响当前任务。`),
				};
			}

			const successful = outcome.filter((check): check is FileCheckSuccess => "result" in check);
			const failed = outcome.filter((check): check is FileCheckFailure => "error" in check);
			if (successful.length === 0) {
				return {
					kind: "skipped",
					checkedFiles: 0,
					diagnosticCount: 0,
					...this.failureNotice("自动 LSP 检查不可用，已跳过，不影响当前任务。"),
				};
			}

			const diagnosticCount = successful.reduce((total, check) => total + check.result.details.resultCount, 0);
			const notice =
				failed.length > 0
					? this.failureNotice(`有 ${failed.length} 个修改文件未能完成 LSP 检查，任务继续执行。`)
					: {};
			if (diagnosticCount === 0) {
				return { kind: "clean", checkedFiles: successful.length, diagnosticCount: 0, ...notice };
			}

			const lines = successful
				.flatMap((check) => check.result.text.split(/\r?\n/).filter((line) => line.trim().length > 0))
				.slice(0, this.maxDiagnostics);
			const omitted = Math.max(0, diagnosticCount - lines.length);
			this.feedbackRounds++;
			return {
				kind: "diagnostics",
				checkedFiles: successful.length,
				diagnosticCount,
				message: [
					`自动 LSP 检查发现 ${diagnosticCount} 个问题（本轮检查 ${successful.length} 个修改文件）：`,
					...lines,
					...(omitted > 0 ? [`另有 ${omitted} 个问题未显示。`] : []),
					"请判断问题是否由本次修改引入，只修复相关问题；LSP 不可用时不要阻塞任务。",
				].join("\n"),
				...notice,
			};
		} finally {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		}
	}

	private failureNotice(message: string): { notice?: string } {
		if (this.failureNoticeShown) return {};
		this.failureNoticeShown = true;
		return { notice: message };
	}

	private warmupKey(cwd: string, filePath: string): string {
		return `${cwd}\0${filePath}`;
	}
}
