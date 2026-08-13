import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let windowsGitBash;

function resolveWindowsGitBash() {
	if (windowsGitBash) return windowsGitBash;

	const result = spawnSync("git", ["--exec-path"], {
		encoding: "utf8",
		shell: true,
	});
	if (result.status !== 0 || !result.stdout.trim()) {
		throw new Error("Git Bash is required to run release shell scripts on Windows.");
	}

	const gitRoot = dirname(dirname(dirname(resolve(result.stdout.trim()))));
	const bash = join(gitRoot, "bin", "bash.exe");
	if (!existsSync(bash)) {
		throw new Error(`Git Bash was not found at the expected path: ${bash}`);
	}

	windowsGitBash = bash;
	return bash;
}

export function runShellScript(script, args = [], options = {}) {
	const command = process.platform === "win32" ? resolveWindowsGitBash() : script;
	const commandArgs = process.platform === "win32" ? [script, ...args] : args;
	return spawnSync(command, commandArgs, { ...options, shell: false });
}
