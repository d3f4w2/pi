export interface BrowserElement {
	ref: string;
	role: string;
	name: string;
	tag: string;
	value?: string;
	disabled?: boolean;
}

export interface BrowserSnapshot {
	url: string;
	title: string;
	text: string;
	elements: BrowserElement[];
	truncated: boolean;
	version?: number;
	tabId?: string;
}

export interface BrowserConsoleEntry {
	level: "log" | "info" | "warning" | "error";
	text: string;
	timestamp: number;
}

export interface BrowserTab {
	id: string;
	url: string;
	title: string;
	active: boolean;
}

export interface BrowserDownload {
	name: string;
	path: string;
	bytes: number;
	completed: boolean;
	modifiedAt: string;
}

export interface BrowserFailedRequest {
	url: string;
	error: string;
	timestamp: number;
	canceled: boolean;
}

export interface BrowserDiagnostics {
	pageErrors: BrowserConsoleEntry[];
	failedRequests: BrowserFailedRequest[];
}

export type BrowserWaitCondition =
	| { kind: "selector"; value: string }
	| { kind: "text"; value: string }
	| { kind: "url"; value: string }
	| { kind: "network_idle" };

export interface BrowserStatus {
	running: boolean;
	url?: string;
	title?: string;
	browser?: string;
	tabId?: string;
	isolated?: boolean;
}

export interface BrowserPageSession {
	status(signal?: AbortSignal): Promise<BrowserStatus>;
	open(url: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	navigate(url: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	back(signal?: AbortSignal): Promise<BrowserSnapshot>;
	forward(signal?: AbortSignal): Promise<BrowserSnapshot>;
	reload(signal?: AbortSignal): Promise<BrowserSnapshot>;
	snapshot(signal?: AbortSignal): Promise<BrowserSnapshot>;
	click(ref: string, version: number | undefined, waitMs: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	type(
		ref: string,
		version: number | undefined,
		text: string,
		submit: boolean,
		waitMs: number,
		signal?: AbortSignal,
	): Promise<BrowserSnapshot>;
	wait(condition: BrowserWaitCondition, timeoutMs: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	hover(ref: string, version: number | undefined, signal?: AbortSignal): Promise<BrowserSnapshot>;
	press(
		ref: string | undefined,
		version: number | undefined,
		key: string,
		signal?: AbortSignal,
	): Promise<BrowserSnapshot>;
	select(
		ref: string,
		version: number | undefined,
		values: readonly string[],
		signal?: AbortSignal,
	): Promise<BrowserSnapshot>;
	upload(
		ref: string,
		version: number | undefined,
		paths: readonly string[],
		signal?: AbortSignal,
	): Promise<BrowserSnapshot>;
	tabs(signal?: AbortSignal): Promise<BrowserTab[]>;
	newTab(url: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	switchTab(tabId: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	closeTab(tabId: string, signal?: AbortSignal): Promise<BrowserTab[]>;
	console(clear?: boolean): Promise<BrowserConsoleEntry[]>;
	errors(clear?: boolean): Promise<BrowserDiagnostics>;
	downloads(): Promise<BrowserDownload[]>;
	screenshot(fullPage: boolean, signal?: AbortSignal): Promise<string>;
	close(): Promise<void>;
}

export type BrowserPageFactory = (signal?: AbortSignal, workspace?: string) => Promise<BrowserPageSession>;

export interface BrowserControllerService {
	status(signal?: AbortSignal): Promise<BrowserStatus>;
	open(url: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	navigate(url: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	back(signal?: AbortSignal): Promise<BrowserSnapshot>;
	forward(signal?: AbortSignal): Promise<BrowserSnapshot>;
	reload(signal?: AbortSignal): Promise<BrowserSnapshot>;
	snapshot(signal?: AbortSignal): Promise<BrowserSnapshot>;
	click(ref: string, version?: number, waitMs?: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	type(
		ref: string,
		version: number | undefined,
		text: string,
		submit?: boolean,
		waitMs?: number,
		signal?: AbortSignal,
	): Promise<BrowserSnapshot>;
	wait(condition: BrowserWaitCondition, timeoutMs?: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	hover(ref: string, version?: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	press(
		ref: string | undefined,
		version: number | undefined,
		key: string,
		signal?: AbortSignal,
	): Promise<BrowserSnapshot>;
	select(
		ref: string,
		version: number | undefined,
		values: readonly string[],
		signal?: AbortSignal,
	): Promise<BrowserSnapshot>;
	upload(
		ref: string,
		version: number | undefined,
		paths: readonly string[],
		signal?: AbortSignal,
	): Promise<BrowserSnapshot>;
	tabs(signal?: AbortSignal): Promise<BrowserTab[]>;
	newTab(url?: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	switchTab(tabId: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	closeTab(tabId: string, signal?: AbortSignal): Promise<BrowserTab[]>;
	console(clear?: boolean): Promise<BrowserConsoleEntry[]>;
	errors(clear?: boolean): Promise<BrowserDiagnostics>;
	downloads(): Promise<BrowserDownload[]>;
	screenshot(fullPage?: boolean, signal?: AbortSignal): Promise<string>;
	close(): Promise<void>;
}

export type BrowserOperation =
	| "open"
	| "navigate"
	| "back"
	| "forward"
	| "reload"
	| "snapshot"
	| "click"
	| "type"
	| "wait"
	| "hover"
	| "press"
	| "select"
	| "upload"
	| "tabs"
	| "new_tab"
	| "switch_tab"
	| "close_tab"
	| "console"
	| "errors"
	| "downloads"
	| "screenshot"
	| "status"
	| "close";

export type BrowserToolDetails =
	| {
			operation:
				| "open"
				| "navigate"
				| "back"
				| "forward"
				| "reload"
				| "snapshot"
				| "click"
				| "type"
				| "wait"
				| "hover"
				| "press"
				| "select"
				| "upload"
				| "new_tab"
				| "switch_tab";
			snapshot: BrowserSnapshot;
	  }
	| { operation: "tabs" | "close_tab"; tabs: BrowserTab[] }
	| { operation: "console"; entries: BrowserConsoleEntry[] }
	| { operation: "errors"; diagnostics: BrowserDiagnostics }
	| { operation: "downloads"; downloads: BrowserDownload[] }
	| { operation: "screenshot"; url?: string; fullPage: boolean }
	| { operation: "status"; status: BrowserStatus }
	| { operation: "close" };
