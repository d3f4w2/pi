export const LSP_OPERATIONS = [
	"definition",
	"type_definition",
	"references",
	"implementation",
	"hover",
	"symbols",
	"workspace_symbols",
	"diagnostics",
	"rename",
	"rename_file",
	"code_actions",
	"status",
	"reload",
	"capabilities",
	"request",
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
	newPath?: string;
	actionKind?: string;
	apply?: boolean;
	method?: string;
	payload?: string;
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
	readonly capabilities: ServerCapabilities;
	readonly transportKind?: "shared" | "private";
	readonly brokerPid?: number;
	readonly languageServerPid?: number;
	openDocument(filePath: string): Promise<LspDocument>;
	definition(document: LspDocument, position: Position, signal?: AbortSignal): Promise<Array<Location | LocationLink>>;
	typeDefinition(
		document: LspDocument,
		position: Position,
		signal?: AbortSignal,
	): Promise<Array<Location | LocationLink>>;
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
	codeActions(
		document: LspDocument,
		range: Range,
		diagnostics: Diagnostic[],
		only: string[] | undefined,
		signal?: AbortSignal,
	): Promise<Array<Command | CodeAction>>;
	resolveCodeAction(action: CodeAction, signal?: AbortSignal): Promise<CodeAction>;
	executeCommand(
		command: Command,
		signal?: AbortSignal,
		applyWorkspaceEdit?: (edit: WorkspaceEdit) => Promise<void>,
	): Promise<unknown>;
	willRenameFiles(oldPath: string, newPath: string, signal?: AbortSignal): Promise<WorkspaceEdit | null>;
	didRenameFiles(oldPath: string, newPath: string): Promise<void>;
	rawRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
	refreshOpenDocument(filePath: string): Promise<void>;
	reloadShared?(): Promise<void>;
	stop(): Promise<void>;
}

export interface LspBrokerClientOptions {
	enabled?: boolean;
	endpoint?: string;
	autoStart?: boolean;
	connectTimeoutMs?: number;
}

export interface LspClientOptions {
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
	broker?: LspBrokerClientOptions;
}

export type LspClientFactory = (
	adapter: LanguageAdapter,
	workspaceRoot: string,
	options?: LspClientOptions,
) => Promise<LspClient>;

import type {
	CodeAction,
	Command,
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	Position,
	Range,
	ServerCapabilities,
	SymbolInformation,
	WorkspaceEdit,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
