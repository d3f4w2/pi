export type ManagedProcessState = "running" | "exited" | "failed" | "stopped";

export interface ManagedProcessSpec {
	command: string;
	args: string[];
	cwd: string;
	label?: string;
}

export interface ManagedProcessInfo {
	id: string;
	label: string;
	command: string;
	args: string[];
	cwd: string;
	state: ManagedProcessState;
	startedAt: string;
	pid?: number;
	exitCode?: number;
	exitSignal?: NodeJS.Signals;
	error?: string;
	urls: string[];
	logCursor: number;
}

export interface ProcessLogResult {
	id: string;
	text: string;
	nextCursor: number;
	truncated: boolean;
	state: ManagedProcessState;
}

export type ProcessOperation = "start" | "status" | "logs" | "restart" | "stop";

export type ProcessToolDetails =
	| { operation: "start" | "restart" | "stop"; process: ManagedProcessInfo }
	| { operation: "status"; processes: ManagedProcessInfo[] }
	| { operation: "logs"; logs: ProcessLogResult };

export interface BackgroundProcessService {
	start(spec: ManagedProcessSpec, workspaceRoot: string, signal?: AbortSignal): Promise<ManagedProcessInfo>;
	status(id?: string): Promise<ManagedProcessInfo[]>;
	logs(id: string, cursor?: number): Promise<ProcessLogResult>;
	restart(id: string, signal?: AbortSignal): Promise<ManagedProcessInfo>;
	stop(id: string): Promise<ManagedProcessInfo>;
	stopAll(): Promise<void>;
}
