import { createHash } from "node:crypto";
import path from "node:path";

const WORKSPACE_RUN_DIRECTORY = "by-workspace";

function normalizeWorkspaceRoot(workspaceRoot: string, platform: NodeJS.Platform): string {
	const pathImplementation = platform === "win32" ? path.win32 : path.posix;
	const normalized = pathImplementation.resolve(workspaceRoot).replaceAll("\\", "/");
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function hashWorkspaceRoot(workspaceRoot: string, platform: NodeJS.Platform = process.platform): string {
	return createHash("sha256").update(normalizeWorkspaceRoot(workspaceRoot, platform)).digest("hex");
}

export function getWorkspaceRunDirectory(
	agentDir: string,
	workspaceRoot: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return path.join(agentDir, "runs", WORKSPACE_RUN_DIRECTORY, hashWorkspaceRoot(workspaceRoot, platform));
}

export function getWorkspaceReceiptPath(
	agentDir: string,
	workspaceRoot: string,
	runId: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return path.join(getWorkspaceRunDirectory(agentDir, workspaceRoot, platform), `${runId}.json`);
}
