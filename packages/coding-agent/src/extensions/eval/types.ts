export type EvalLanguage = "python" | "bun";
export type EvalOperation = "execute" | "reset" | "status";

export interface EvalWorkerResponse {
	ok: boolean;
	stdout: string;
	stderr: string;
	value?: string;
	error?: string;
}

export interface EvalExecutionResult extends EvalWorkerResponse {
	language: EvalLanguage;
	durationMs: number;
	restarted: boolean;
	truncated: boolean;
}

export interface EvalToolDetails {
	operation: EvalOperation;
	language?: EvalLanguage;
	durationMs: number;
	running: EvalLanguage[];
	restarted: boolean;
	truncated: boolean;
}

export interface EvalRuntimeService {
	execute(
		language: EvalLanguage,
		code: string,
		cwd: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<EvalExecutionResult>;
	reset(language?: EvalLanguage): Promise<EvalLanguage[]>;
	status(): EvalLanguage[];
	stopAll(): Promise<void>;
}
