export type DebugLanguage = "python" | "javascript" | "go";
export type DebugOperation =
	| "start"
	| "attach"
	| "set_breakpoints"
	| "set_function_breakpoints"
	| "set_exception_breakpoints"
	| "data_breakpoint_info"
	| "set_data_breakpoints"
	| "threads"
	| "pause"
	| "continue"
	| "next"
	| "step_in"
	| "step_out"
	| "stack"
	| "scopes"
	| "variables"
	| "evaluate"
	| "loaded_sources"
	| "modules"
	| "restart"
	| "status"
	| "disconnect"
	| "stop";

export interface DapRequest {
	seq: number;
	type: "request";
	command: string;
	arguments?: Record<string, unknown>;
}

export interface DapResponse {
	seq: number;
	type: "response";
	request_seq: number;
	success: boolean;
	command: string;
	message?: string;
	body?: unknown;
}

export interface DapEvent {
	seq: number;
	type: "event";
	event: string;
	body?: unknown;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

export interface DapTransport {
	write(data: Uint8Array): void;
	onData(listener: (data: Uint8Array) => void): void;
	onClose(listener: (error?: Error) => void): void;
	dispose(): Promise<void>;
}

export interface DebugStartRequest {
	language: DebugLanguage;
	path: string;
	args: string[];
	breakpoints: number[];
	stopOnEntry: boolean;
	cwd: string;
}

export interface DebugAttachRequest {
	language: DebugLanguage;
	path?: string;
	processId?: number;
	host?: string;
	port?: number;
	breakpoints: number[];
	cwd: string;
}

export type DebugAdapterRequest = (DebugStartRequest & { mode: "launch" }) | (DebugAttachRequest & { mode: "attach" });

export interface DebugActionRequest {
	operation: Exclude<DebugOperation, "start">;
	path?: string;
	lines?: number[];
	threadId?: number;
	frameId?: number;
	variablesReference?: number;
	expression?: string;
	functionNames?: string[];
	exceptionFilters?: string[];
	dataIds?: string[];
	name?: string;
	condition?: string;
	hitCondition?: string;
	logMessage?: string;
	accessType?: string;
}

export interface DebugResult {
	text: string;
	details: DebugToolDetails;
}

export interface DebugToolDetails {
	operation: DebugOperation;
	language?: DebugLanguage;
	mode?: "launch" | "attach";
	state: "idle" | "starting" | "running" | "stopped" | "terminated";
	threadId?: number;
	itemCount: number;
	truncated: boolean;
}

export interface DebugServiceLike {
	start(request: DebugStartRequest, signal?: AbortSignal): Promise<DebugResult>;
	attach(request: DebugAttachRequest, signal?: AbortSignal): Promise<DebugResult>;
	action(request: DebugActionRequest, cwd: string, signal?: AbortSignal): Promise<DebugResult>;
	stop(): Promise<void>;
}
