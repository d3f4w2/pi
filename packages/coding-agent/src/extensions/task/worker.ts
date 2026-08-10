import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { TaskWorkerManager } from "./manager.ts";
import type {
	TaskWorkerLaunchContext,
	TaskWorkerRunResult,
	TaskWorkerService,
	TaskWorkerSnapshot,
	TaskWorkerStartRequest,
} from "./types.ts";
import {
	changedWorkspaceFiles,
	createIsolatedWorkspace,
	disposeIsolatedWorkspace,
	type IsolatedWorkspace,
} from "./workspace.ts";

const RESEARCH_TOOLS = ["read", "grep", "find", "ls"];
const CODING_TOOLS = [...RESEARCH_TOOLS, "edit", "write", "bash"];

function workerPrompt(request: TaskWorkerStartRequest): string {
	const scope =
		request.profile === "coding"
			? "You may inspect and modify files, then run focused verification."
			: "Research only. Do not modify files or run commands.";
	return [
		"You are a bounded task worker operating in an isolated snapshot.",
		scope,
		"Do not ask the user questions. Report concrete evidence and verification.",
		"Changes are not merged automatically into the parent workspace.",
		"Task:",
		request.prompt,
	].join("\n\n");
}

async function runWorker(
	request: TaskWorkerStartRequest,
	context: TaskWorkerLaunchContext,
	signal: AbortSignal,
	retainWorkspace: (workspace: IsolatedWorkspace) => void,
): Promise<TaskWorkerRunResult> {
	const workspace = await createIsolatedWorkspace(context.cwd);
	retainWorkspace(workspace);
	if (signal.aborted) throw signal.reason;
	const settingsManager = SettingsManager.inMemory({ tools: { approvalMode: "yolo" } });
	const { session } = await createAgentSession({
		cwd: workspace.workspacePath,
		...(context.model === undefined ? {} : { model: context.model }),
		...(context.thinkingLevel === undefined ? {} : { thinkingLevel: context.thinkingLevel as ThinkingLevel }),
		tools: request.profile === "coding" ? CODING_TOOLS : RESEARCH_TOOLS,
		sessionManager: SessionManager.inMemory(workspace.workspacePath),
		settingsManager,
	});
	const abort = () => void session.abort();
	signal.addEventListener("abort", abort, { once: true });
	try {
		await session.prompt(workerPrompt(request));
		if (signal.aborted) throw signal.reason;
		const stats = session.getSessionStats();
		return {
			output: session.getLastAssistantText() ?? "Task worker completed without a text response.",
			changedFiles: await changedWorkspaceFiles(workspace),
			verification: ["isolated agent turn completed"],
			usage: {
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				totalTokens: stats.tokens.total,
				toolCalls: stats.toolCalls,
			},
			workspacePath: workspace.workspacePath,
		};
	} finally {
		signal.removeEventListener("abort", abort);
		session.dispose();
	}
}

export class TaskWorkerRuntime implements TaskWorkerService {
	private readonly manager: TaskWorkerManager;
	private readonly workspaces = new Map<string, IsolatedWorkspace>();

	constructor(manager = new TaskWorkerManager()) {
		this.manager = manager;
	}

	start(request: TaskWorkerStartRequest, context: TaskWorkerLaunchContext): TaskWorkerSnapshot {
		let id = "";
		const snapshot = this.manager.start(request, (signal) =>
			runWorker(request, context, signal, (workspace) => {
				this.workspaces.set(id, workspace);
			}),
		);
		id = snapshot.id;
		return snapshot;
	}

	status(id?: string): TaskWorkerSnapshot[] {
		return this.manager.status(id);
	}

	result(id: string): TaskWorkerSnapshot {
		return this.manager.result(id);
	}

	cancel(id: string): Promise<TaskWorkerSnapshot> {
		return this.manager.cancel(id);
	}

	async stopAll(): Promise<void> {
		await this.manager.stopAll();
		await Promise.all([...this.workspaces.values()].map((workspace) => disposeIsolatedWorkspace(workspace.rootPath)));
		this.workspaces.clear();
	}
}
