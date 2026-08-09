import type { FileDiff } from "../../core/tools/edit-diff.ts";

export type GitDiffScope = "all" | "staged" | "worktree";

export interface GitChangedFile {
	path: string;
	originalPath?: string;
	indexStatus: string;
	worktreeStatus: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	conflicted: boolean;
}

export interface GitOverview {
	repositoryRoot: string;
	branch: string;
	upstream?: string;
	ahead: number;
	behind: number;
	files: GitChangedFile[];
	truncated: boolean;
}

export interface GitLogEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
}

export interface GitCommandResult {
	code: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
}

export interface GitCommandRunner {
	run(
		args: readonly string[],
		cwd: string,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<GitCommandResult>;
}

export type GitToolDetails =
	| { operation: "overview"; overview: GitOverview }
	| { operation: "diff"; scope: GitDiffScope; file: GitChangedFile; diff: FileDiff }
	| { operation: "log"; entries: GitLogEntry[] }
	| { operation: "stage" | "unstage"; paths: string[]; overview: GitOverview }
	| { operation: "commit"; hash: string; paths: string[] }
	| { operation: "push"; output: string };
