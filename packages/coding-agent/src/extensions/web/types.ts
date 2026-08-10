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
	provider: "official" | "brave" | "duckduckgo";
	query: string;
	resultCount: number;
	durationMs: number;
	fallbackReason?: string;
	officialSourceFirstHit?: boolean;
	officialSourceVerified?: boolean;
	officialVerificationCached?: boolean;
	sourceAddress: string;
	strategy?: "official-direct" | "generic-search" | "single-fallback";
	readAt: string;
	contentType: "application/vnd.pi.search-results+text";
	cached: false;
	truncated: boolean;
	untrusted: true;
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
	sourceAddress: string;
	readAt: string;
	cached: boolean;
	untrusted: true;
	contentSha256: string;
}
