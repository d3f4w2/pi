export type TurnUndoChangeKind = "modified" | "created" | "deleted";

export interface TurnUndoFileChange {
	path: string;
	kind: TurnUndoChangeKind;
	beforeFile?: string;
	beforeMode?: number;
	afterState?: string;
}

export interface TurnUndoSnapshot {
	version: 1;
	id: string;
	root: string;
	sessionId: string;
	headRef: string;
	createdAt: string;
	state: "ready" | "undone";
	files: TurnUndoFileChange[];
}

export interface BaselineUntrackedFile {
	path: string;
	storedFile: string;
	state: string;
	mode: number;
	size: number;
}

export interface BaselineTrackedOverride {
	path: string;
	storedFile?: string;
	state?: string;
	mode?: number;
	size: number;
}

export interface TurnUndoCapture {
	id: string;
	root: string;
	realRoot: string;
	sessionId: string;
	startedAt: string;
	headRef: string;
	baseRef: string;
	directory: string;
	workspaceDirectory: string;
	lockToken: string;
	untracked: BaselineUntrackedFile[];
	trackedOverrides: BaselineTrackedOverride[];
}

export interface TurnUndoLimits {
	maxFileBytes: number;
	maxSnapshotBytes: number;
	maxUntrackedFiles: number;
	maxChangedFiles: number;
	maxSnapshots: number;
}

export type TurnUndoBeginResult =
	| { status: "started"; capture: TurnUndoCapture }
	| { status: "skipped"; reason: string };

export type TurnUndoFinalizeResult =
	| { status: "saved"; snapshot: TurnUndoSnapshot }
	| { status: "unchanged" }
	| { status: "skipped"; reason: string };

export type TurnUndoResult =
	| { status: "restored"; snapshot: TurnUndoSnapshot; warning?: string }
	| { status: "none" }
	| { status: "busy"; reason: string }
	| { status: "conflict"; paths: string[] }
	| { status: "failed"; reason: string };
