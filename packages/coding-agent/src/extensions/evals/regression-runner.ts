import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ExecOptions, ExecResult } from "../../core/exec.ts";
import type { ApprovedRegressionCase } from "./types.ts";

const RUN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARACTERS = 6_000;

export type RegressionCaseExecutor = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

interface VerifiedCaseFile {
	path: string;
	absolutePath: string;
	content: string;
}

interface PlannedCommand {
	runner: "node:test" | "vitest" | "pytest" | "go test";
	command: string;
	args: string[];
	cwd: string;
	display: string;
}

export interface RegressionCaseRunResult {
	caseId: string;
	passed: boolean;
	killed: boolean;
	runner: PlannedCommand["runner"];
	durationMs: number;
	commands: string[];
	output: string;
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function verifyCaseFiles(
	workspace: string,
	testCase: ApprovedRegressionCase,
): Promise<{
	root: string;
	files: VerifiedCaseFile[];
}> {
	const root = await realpath(workspace);
	const files: VerifiedCaseFile[] = [];
	for (const approvedFile of testCase.files) {
		const candidate = path.resolve(root, approvedFile.path);
		if (!within(root, candidate)) throw new Error(`测试文件超出当前项目：${approvedFile.path}`);
		let resolved: string;
		try {
			resolved = await realpath(candidate);
		} catch {
			throw new Error(`测试文件不存在：${approvedFile.path}`);
		}
		if (!within(root, resolved)) throw new Error(`测试文件通过链接跳出当前项目：${approvedFile.path}`);
		const content = await readFile(resolved, "utf8");
		const digest = createHash("sha256").update(content).digest("hex");
		if (digest !== approvedFile.digest || Buffer.byteLength(content, "utf8") !== approvedFile.bytes) {
			throw new Error(`测试文件在批准后已被修改，拒绝直接执行：${approvedFile.path}`);
		}
		files.push({ path: approvedFile.path.replaceAll("\\", "/"), absolutePath: resolved, content });
	}
	return { root, files };
}

async function findPackageRoot(start: string, workspaceRoot: string): Promise<string> {
	let current = start;
	while (within(workspaceRoot, current)) {
		try {
			await access(path.join(current, "package.json"));
			return current;
		} catch {
			if (current === workspaceRoot) break;
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	return workspaceRoot;
}

async function commonPackageRoot(files: VerifiedCaseFile[], workspaceRoot: string): Promise<string> {
	const roots = await Promise.all(
		files.map((file) => findPackageRoot(path.dirname(file.absolutePath), workspaceRoot)),
	);
	if (roots.some((root) => root !== roots[0])) throw new Error("一个 case 不能跨多个包运行测试。");
	return roots[0] ?? workspaceRoot;
}

async function findVitestCli(packageRoot: string, workspaceRoot: string): Promise<string> {
	let current = packageRoot;
	while (within(workspaceRoot, current)) {
		const candidate = path.join(current, "node_modules", "vitest", "dist", "cli.js");
		try {
			await access(candidate);
			return candidate;
		} catch {
			if (current === workspaceRoot) break;
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}
	throw new Error("项目没有安装 Vitest，无法运行这个 case。");
}

function displayArgument(argument: string): string {
	return /\s/.test(argument) ? JSON.stringify(argument) : argument;
}

function displayCommand(command: string, args: string[]): string {
	return [command, ...args].map(displayArgument).join(" ");
}

async function planCommands(root: string, files: VerifiedCaseFile[]): Promise<PlannedCommand[]> {
	const extensions = new Set(files.map((file) => path.extname(file.path).toLowerCase()));
	const javascriptExtensions = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]);
	if ([...extensions].every((extension) => javascriptExtensions.has(extension))) {
		const packageRoot = await commonPackageRoot(files, root);
		const relativeFiles = files.map((file) => path.relative(packageRoot, file.absolutePath));
		const usesVitest = files.some((file) => /(?:from\s+|require\()\s*["']vitest["']/.test(file.content));
		if (usesVitest) {
			const vitestCli = await findVitestCli(packageRoot, root);
			const args = [vitestCli, "--run", ...relativeFiles];
			return [
				{
					runner: "vitest",
					command: process.execPath,
					args,
					cwd: packageRoot,
					display: displayCommand("vitest", args.slice(1)),
				},
			];
		}
		const usesNodeTest = files.some((file) => /(?:from\s+|require\()\s*["']node:test["']/.test(file.content));
		if (!usesNodeTest) throw new Error("无法识别 JavaScript/TypeScript 测试框架。");
		if (extensions.has(".tsx") || extensions.has(".jsx")) throw new Error("node:test 一键运行暂不支持 JSX/TSX。");
		const typeScript = [...extensions].some(
			(extension) => extension === ".ts" || extension === ".mts" || extension === ".cts",
		);
		const args = [
			...(typeScript ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] : []),
			"--test",
			...relativeFiles,
		];
		return [
			{
				runner: "node:test",
				command: process.execPath,
				args,
				cwd: packageRoot,
				display: displayCommand("node", args),
			},
		];
	}
	if ([...extensions].every((extension) => extension === ".py")) {
		const packageRoot = await commonPackageRoot(files, root);
		const relativeFiles = files.map((file) => path.relative(packageRoot, file.absolutePath));
		const command = process.platform === "win32" ? "python" : "python3";
		const args = ["-m", "pytest", ...relativeFiles];
		return [{ runner: "pytest", command, args, cwd: packageRoot, display: displayCommand(command, args) }];
	}
	if (
		[...extensions].every((extension) => extension === ".go") &&
		files.every((file) => file.path.endsWith("_test.go"))
	) {
		const directories = [...new Set(files.map((file) => path.posix.dirname(file.path)))];
		return directories.map((directory) => {
			const target = directory === "." ? "." : `./${directory}`;
			const args = ["test", target];
			return { runner: "go test", command: "go", args, cwd: root, display: displayCommand("go", args) };
		});
	}
	throw new Error("case 使用了不支持或混合的测试文件类型。");
}

function boundedOutput(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= MAX_OUTPUT_CHARACTERS) return trimmed;
	const edge = Math.floor((MAX_OUTPUT_CHARACTERS - 100) / 2);
	return `${trimmed.slice(0, edge)}\n\n… 已省略 ${trimmed.length - edge * 2} 个字符 …\n\n${trimmed.slice(-edge)}`;
}

export async function runApprovedRegressionCase(
	workspace: string,
	testCase: ApprovedRegressionCase,
	execute: RegressionCaseExecutor,
	signal?: AbortSignal,
): Promise<RegressionCaseRunResult> {
	const { root, files } = await verifyCaseFiles(workspace, testCase);
	const planned = await planCommands(root, files);
	const output: string[] = [];
	let passed = true;
	let killed = false;
	const startedAt = performance.now();
	for (const command of planned) {
		const result = await execute(command.command, command.args, {
			cwd: command.cwd,
			timeout: RUN_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		});
		output.push(
			[`$ ${command.display}`, result.stdout.trim(), result.stderr.trim()]
				.filter((line) => line.length > 0)
				.join("\n"),
		);
		if (result.code !== 0 || result.killed) {
			passed = false;
			killed = result.killed;
			break;
		}
	}
	return {
		caseId: testCase.id,
		passed,
		killed,
		runner: planned[0]?.runner ?? "node:test",
		durationMs: Math.round(performance.now() - startedAt),
		commands: planned.map((command) => command.display),
		output: boundedOutput(output.join("\n\n")),
	};
}

export function selectApprovedRegressionCase(
	cases: ApprovedRegressionCase[],
	selector?: string,
): ApprovedRegressionCase | undefined {
	if (!selector) return [...cases].sort((a, b) => a.approvedAt.localeCompare(b.approvedAt)).at(-1);
	const exact = cases.find((testCase) => testCase.id === selector);
	if (exact) return exact;
	const matches = cases.filter((testCase) => testCase.id.startsWith(selector));
	return matches.length === 1 ? matches[0] : undefined;
}
