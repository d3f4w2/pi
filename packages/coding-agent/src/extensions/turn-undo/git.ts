import { spawn } from "node:child_process";

const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

interface GitResult {
	stdout: Buffer;
	stderr: Buffer;
}

export interface GitChange {
	path: string;
	status: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn("git", ["-c", "core.quotePath=false", "-c", "core.fsmonitor=false", ...args], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error("Git 操作超时"));
		}, GIT_TIMEOUT_MS);

		const collect = (target: Buffer[], chunk: Buffer): void => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
				child.kill();
				return;
			}
			target.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.on("error", (error) => {
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
				reject(new Error("Git 输出超过安全上限"));
				return;
			}
			const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
			if (code === 0) {
				resolve(result);
				return;
			}
			const detail = result.stderr.toString("utf8").trim();
			reject(new Error(detail || `Git 退出码 ${code ?? "unknown"}`));
		});
	});
}

export async function findGitRoot(cwd: string): Promise<string | undefined> {
	try {
		return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.toString("utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

export async function createGitBaseline(root: string): Promise<{ headRef: string; baseRef: string }> {
	let headRef: string;
	try {
		headRef = (await runGit(root, ["rev-parse", "HEAD"])).stdout.toString("utf8").trim();
	} catch {
		throw new Error("Git 仓库还没有提交，无法建立安全基线");
	}
	const stashRef = (await runGit(root, ["stash", "create"])).stdout.toString("utf8").trim();
	return { headRef, baseRef: stashRef || headRef };
}

export async function getCurrentHead(root: string): Promise<string> {
	return (await runGit(root, ["rev-parse", "HEAD"])).stdout.toString("utf8").trim();
}

function parseNullSeparated(buffer: Buffer): string[] {
	const values = buffer.toString("utf8").split("\0");
	if (values.at(-1) === "") values.pop();
	return values;
}

export async function listUntrackedFiles(root: string): Promise<string[]> {
	return parseNullSeparated((await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout);
}

export async function listDirtyTrackedFiles(root: string, headRef: string): Promise<string[]> {
	return parseNullSeparated(
		(await runGit(root, ["diff", "--no-ext-diff", "--name-only", "-z", "--no-renames", headRef, "--"])).stdout,
	);
}

export async function listWorkspaceChanges(root: string, baseRef: string): Promise<GitChange[]> {
	const fields = parseNullSeparated(
		(await runGit(root, ["diff", "--no-ext-diff", "--name-status", "-z", "--no-renames", baseRef, "--"])).stdout,
	);
	if (fields.length % 2 !== 0) throw new Error("无法解析 Git 文件变化");
	const changes: GitChange[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		changes.push({ status: fields[index] ?? "", path: fields[index + 1] ?? "" });
	}
	return changes;
}

export async function readBaselineFile(root: string, baseRef: string, path: string): Promise<Buffer> {
	return (await runGit(root, ["cat-file", "--filters", `--path=${path}`, `${baseRef}:${path}`])).stdout;
}

export async function readBaselineMode(root: string, baseRef: string, path: string): Promise<number> {
	const output = (await runGit(root, ["ls-tree", baseRef, "--", path])).stdout.toString("utf8");
	const match = /^(100644|100755)\s/.exec(output);
	if (!match) throw new Error(`不支持的 Git 文件类型：${path}`);
	return match[1] === "100755" ? 0o755 : 0o644;
}
