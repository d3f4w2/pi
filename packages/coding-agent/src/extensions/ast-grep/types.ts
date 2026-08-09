export const AST_GREP_EXPLICIT_LANGUAGES = ["javascript", "typescript", "tsx", "html", "css"] as const;
export const AST_GREP_LANGUAGES = ["auto", ...AST_GREP_EXPLICIT_LANGUAGES] as const;

export type AstGrepLanguage = (typeof AST_GREP_LANGUAGES)[number];
export type AstGrepExplicitLanguage = (typeof AST_GREP_EXPLICIT_LANGUAGES)[number];

export interface AstGrepSearchRequest {
	pattern: string;
	language: AstGrepLanguage;
	path?: string;
	maxResults?: number;
}

export interface AstGrepSearchDetails {
	language: AstGrepLanguage;
	path: string;
	resultCount: number;
	scannedFiles: number;
	skippedFiles: number;
	truncated: boolean;
	outputTruncated: boolean;
	durationMs: number;
}

export interface AstGrepSearchResult {
	text: string;
	details: AstGrepSearchDetails;
}
