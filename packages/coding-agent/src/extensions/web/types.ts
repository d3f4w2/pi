export type WebFetchFormat = "markdown" | "text" | "html";

export interface SearchResultItem {
	title: string;
	url: string;
	snippet?: string;
}

export interface SearchFilters {
	allowedDomains?: readonly string[];
	blockedDomains?: readonly string[];
}

export interface WebSearchDetails {
	provider: "brave" | "duckduckgo";
	query: string;
	resultCount: number;
	durationMs: number;
	fallbackReason?: string;
}

export interface WebFetchDetails {
	url: string;
	finalUrl: string;
	format: WebFetchFormat;
	status: number;
	contentType: string;
	bytes: number;
	outputBytes: number;
	truncated: boolean;
}
