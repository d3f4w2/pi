export type DoctorSeverity = "ok" | "info" | "warning" | "error";
export type DoctorArea = "core" | "shell" | "lsp" | "search" | "web" | "config";
export type DoctorLanguage = "typescript" | "python" | "go";

export interface DoctorFinding {
	id: string;
	area: DoctorArea;
	severity: DoctorSeverity;
	label: string;
	detail: string;
	fix?: string;
}

export interface DoctorModelSnapshot {
	provider: string;
	id: string;
	hasConfiguredAuth: boolean;
}

export interface DoctorPaths {
	settings: string;
	projectSettings: string;
	models: string;
	auth: string;
}

export interface DoctorSettingsError {
	scope: "global" | "project";
	message: string;
}

export interface DoctorSnapshot {
	platform: NodeJS.Platform;
	cwd: string;
	env: Readonly<Record<string, string | undefined>>;
	customShellPath?: string;
	settingsErrors: readonly DoctorSettingsError[];
	modelError?: string;
	availableModelCount: number;
	currentModel?: DoctorModelSnapshot;
	registeredTools: readonly string[];
	activeTools: readonly string[];
	paths: DoctorPaths;
	configFiles: Readonly<Record<"settings" | "projectSettings" | "models" | "auth", boolean>>;
	isBunBinary: boolean;
}

export interface DoctorFileProbes {
	fileExists(path: string): boolean;
	isExecutable(path: string): boolean;
}

export interface DoctorSummary {
	ok: number;
	info: number;
	warning: number;
	error: number;
}

export interface DoctorReport {
	findings: DoctorFinding[];
	summary: DoctorSummary;
	severity: DoctorSeverity;
}
