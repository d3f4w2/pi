import { access, readFile } from "node:fs/promises";
import { type CiCommandDependencies, runCiCommand } from "../../cli/ci-command.ts";
import { discoverCiReceiptFiles } from "../../cli/ci-files.ts";
import { getWorkspaceRunDirectory } from "../../cli/project-runs.ts";
import { getGitWorkspaceRoot } from "../../cli/run-workspace.ts";
import { getAgentDir } from "../../config.ts";
import { tokenizeGoalCommand } from "./state.ts";

export interface InteractiveCiResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type InteractiveCiRunner = (args: readonly string[], dependencies: CiCommandDependencies) => Promise<number>;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

export async function runInteractiveCi(
	input: string,
	cwd: string,
	runner: InteractiveCiRunner = runCiCommand,
): Promise<InteractiveCiResult> {
	let stdout = "";
	let stderr = "";
	let exitCode = 0;
	const dependencies: CiCommandDependencies = {
		cwd: () => cwd,
		readTextFile: (filePath) => readFile(filePath, "utf8"),
		pathExists,
		getWorkspaceRoot: getGitWorkspaceRoot,
		defaultReceiptDirectory: (workspaceRoot) => getWorkspaceRunDirectory(getAgentDir(), workspaceRoot),
		discoverReceiptFiles: discoverCiReceiptFiles,
		writeStdout: (value) => {
			stdout += value;
		},
		writeStderr: (value) => {
			stderr += value;
		},
		setExitCode: (value) => {
			exitCode = value;
		},
	};
	exitCode = await runner(tokenizeGoalCommand(input), dependencies);
	return { exitCode, stdout, stderr };
}
