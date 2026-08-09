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
}

export interface BrowserConsoleEntry {
	level: "log" | "info" | "warning" | "error";
	text: string;
	timestamp: number;
}

export interface BrowserStatus {
	running: boolean;
	url?: string;
	title?: string;
	browser?: string;
}

export interface BrowserPageSession {
	status(signal?: AbortSignal): Promise<BrowserStatus>;
	open(url: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	snapshot(signal?: AbortSignal): Promise<BrowserSnapshot>;
	click(ref: string, waitMs: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	type(ref: string, text: string, submit: boolean, waitMs: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	console(clear?: boolean): Promise<BrowserConsoleEntry[]>;
	screenshot(signal?: AbortSignal): Promise<string>;
	close(): Promise<void>;
}

export type BrowserPageFactory = (signal?: AbortSignal) => Promise<BrowserPageSession>;

export interface BrowserControllerService {
	status(signal?: AbortSignal): Promise<BrowserStatus>;
	open(url: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
	snapshot(signal?: AbortSignal): Promise<BrowserSnapshot>;
	click(ref: string, waitMs?: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	type(ref: string, text: string, submit?: boolean, waitMs?: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
	console(clear?: boolean): Promise<BrowserConsoleEntry[]>;
	screenshot(signal?: AbortSignal): Promise<string>;
	close(): Promise<void>;
}

export type BrowserOperation = "open" | "snapshot" | "click" | "type" | "console" | "screenshot" | "status" | "close";

export type BrowserToolDetails =
	| { operation: "open" | "snapshot" | "click" | "type"; snapshot: BrowserSnapshot }
	| { operation: "console"; entries: BrowserConsoleEntry[] }
	| { operation: "screenshot"; url?: string }
	| { operation: "status"; status: BrowserStatus }
	| { operation: "close" };
