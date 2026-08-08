export type MgrepErrorKind =
	| "not-installed"
	| "login-required"
	| "quota"
	| "file-limit"
	| "warming"
	| "cancelled"
	| "timeout"
	| "failed";

export type CodeSearchStage = "checking" | "indexing" | "searching" | "complete";

export interface MgrepWatchHandle {
	ready: Promise<void>;
	isRunning(): boolean;
	stop(): void;
}

export interface MgrepWatchOptions {
	cwd: string;
	maxFileCount: number;
}

export interface MgrepSearchOptions {
	query: string;
	path: string;
	cwd: string;
	maxResults: number;
	signal?: AbortSignal;
}

export interface MgrepOperations {
	maxFileCount: number;
	startWatch(options: MgrepWatchOptions, onOutput: (output: string) => void): MgrepWatchHandle;
	search(options: MgrepSearchOptions): Promise<string>;
}

export interface CodeSearchInput {
	query: string;
	path?: string;
	maxResults?: number;
}

export interface CodeSearchDetails {
	stage: CodeSearchStage;
	query: string;
	path: string;
	durationMs: number;
	firstIndex: boolean;
	truncated: boolean;
	indexPath: string;
	maxFileCount: number;
}

export interface CodeSearchResult {
	text: string;
	details: CodeSearchDetails;
}

export type CodeSearchProgress = (message: string, stage: CodeSearchStage, elapsedMs: number) => void;
