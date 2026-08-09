export type VerifyOperation = "auto" | "typecheck" | "test" | "lint";
export type VerifyLanguage = "typescript" | "python" | "go";

export interface VerifyRequest {
	operation: VerifyOperation;
	path?: string;
	timeoutSeconds?: number;
}

export interface VerifyCommand {
	label: string;
	command: string;
	args: string[];
	cwd: string;
}

export interface VerifyCommandResult {
	kind: "exited" | "not_found" | "timed_out" | "aborted";
	code?: number;
	output: string;
	outputTruncated: boolean;
	durationMs?: number;
}

export type VerifyCommandRunner = (
	command: VerifyCommand,
	signal: AbortSignal,
	timeoutMs: number,
) => Promise<VerifyCommandResult>;

export interface PlannedVerifyCheck {
	id: Exclude<VerifyOperation, "auto">;
	label: string;
	commands: VerifyCommand[];
	missingHint: string;
}

export interface VerifyCheckDetails {
	id: PlannedVerifyCheck["id"];
	label: string;
	status: "passed" | "failed" | "unavailable" | "timed_out";
	durationMs: number;
	command?: string;
}

export interface VerifyDetails {
	operation: VerifyOperation;
	language: VerifyLanguage;
	workspaceRoot: string;
	passed: boolean;
	checks: VerifyCheckDetails[];
	logPath?: string;
	truncated: boolean;
	durationMs: number;
}

export interface VerifyResult {
	text: string;
	details: VerifyDetails;
}

export interface VerifyToolService {
	verify(
		request: VerifyRequest,
		cwd: string,
		signal?: AbortSignal,
		onStatus?: (message: string) => void,
	): Promise<VerifyResult>;
}
