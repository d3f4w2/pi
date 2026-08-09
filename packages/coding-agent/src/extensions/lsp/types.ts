export const LSP_OPERATIONS = [
	"definition",
	"references",
	"implementation",
	"hover",
	"symbols",
	"workspace_symbols",
	"diagnostics",
	"rename",
] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

export interface LanguageServerLaunch {
	command: string;
	args: string[];
}

export interface LanguageAdapter {
	id: "typescript" | "python" | "go";
	displayName: string;
	extensions: readonly string[];
	rootMarkers: readonly string[];
	languageId(filePath: string): string;
	launchCandidates(): LanguageServerLaunch[];
}

export interface LspToolRequest {
	operation: LspOperation;
	path: string;
	line?: number;
	column?: number;
	symbol?: string;
	query?: string;
	newName?: string;
	includeDeclaration?: boolean;
	maxResults?: number;
}

export interface LspToolResult {
	text: string;
	details: {
		operation: LspOperation;
		language: LanguageAdapter["id"] | "unknown";
		workspaceRoot: string;
		truncated: boolean;
		resultCount: number;
		changedFiles?: string[];
	};
}

export interface LspDocument {
	filePath: string;
	uri: string;
	languageId: string;
	version: number;
	text: string;
}

export interface LspClient {
	readonly adapter: LanguageAdapter;
	readonly workspaceRoot: string;
	openDocument(filePath: string): Promise<LspDocument>;
	definition(document: LspDocument, position: Position, signal?: AbortSignal): Promise<Array<Location | LocationLink>>;
	references(
		document: LspDocument,
		position: Position,
		includeDeclaration: boolean,
		signal?: AbortSignal,
	): Promise<Location[]>;
	implementation(
		document: LspDocument,
		position: Position,
		signal?: AbortSignal,
	): Promise<Array<Location | LocationLink>>;
	hover(document: LspDocument, position: Position, signal?: AbortSignal): Promise<Hover | null>;
	documentSymbols(document: LspDocument, signal?: AbortSignal): Promise<Array<DocumentSymbol | SymbolInformation>>;
	workspaceSymbols(query: string, signal?: AbortSignal): Promise<Array<SymbolInformation | WorkspaceSymbol>>;
	diagnostics(document: LspDocument, signal?: AbortSignal, waitMs?: number): Promise<Diagnostic[]>;
	rename(
		document: LspDocument,
		position: Position,
		newName: string,
		signal?: AbortSignal,
	): Promise<WorkspaceEdit | null>;
	refreshOpenDocument(filePath: string): Promise<void>;
	stop(): Promise<void>;
}

export interface LspClientOptions {
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
}

export type LspClientFactory = (
	adapter: LanguageAdapter,
	workspaceRoot: string,
	options?: LspClientOptions,
) => Promise<LspClient>;

import type {
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	Position,
	SymbolInformation,
	WorkspaceEdit,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
