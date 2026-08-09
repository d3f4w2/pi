import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { glob } from "glob";
import type { PlannedVerifyCheck, VerifyCommand, VerifyLanguage, VerifyOperation, VerifyRequest } from "./types.ts";

const require = createRequire(import.meta.url);
let bundledTscPath: string | undefined;
try {
	bundledTscPath = require.resolve("typescript/bin/tsc");
} catch {
	// A project-local or PATH tsc may still be available.
}

const IGNORED_PATHS = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/coverage/**"];
const JS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TEST_FILE_PATTERN = /(?:^|[._-])(test|spec)(?:[._-]|$)/i;
const PYTHON_SYNTAX_SCRIPT =
	"import ast,sys,tokenize; f=tokenize.open(sys.argv[1]); source=f.read(); f.close(); ast.parse(source,filename=sys.argv[1])";

interface PackageJson {
	packageManager?: string;
	scripts: Record<string, string>;
}

export interface VerifyWorkspace {
	projectRoot: string;
	workspaceRoot: string;
	targetPath: string;
	relativeTarget: string;
	targetIsFile: boolean;
	language: VerifyLanguage;
	standalone: boolean;
}

export interface VerifyPlan {
	workspace: VerifyWorkspace;
	checks: PlannedVerifyCheck[];
	notes: string[];
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function isPathInside(root: string, candidate: string): boolean {
	const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
	const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function languageHint(filePath: string): VerifyLanguage | undefined {
	const extension = path.extname(filePath).toLowerCase();
	if (JS_EXTENSIONS.has(extension)) return "typescript";
	if (extension === ".py" || extension === ".pyi") return "python";
	if (extension === ".go") return "go";
	return undefined;
}

async function markerLanguages(directory: string): Promise<VerifyLanguage[]> {
	const languages: VerifyLanguage[] = [];
	if (await fileExists(path.join(directory, "package.json"))) languages.push("typescript");
	if ((await fileExists(path.join(directory, "go.mod"))) || (await fileExists(path.join(directory, "go.work")))) {
		languages.push("go");
	}
	if (
		(await fileExists(path.join(directory, "pyproject.toml"))) ||
		(await fileExists(path.join(directory, "requirements.txt"))) ||
		(await fileExists(path.join(directory, "setup.cfg"))) ||
		(await fileExists(path.join(directory, "setup.py")))
	) {
		languages.push("python");
	}
	return languages;
}

export async function resolveVerifyWorkspace(cwd: string, requestedPath = "."): Promise<VerifyWorkspace> {
	const projectRoot = await realpath(cwd);
	let targetPath: string;
	try {
		targetPath = await realpath(path.resolve(projectRoot, requestedPath));
	} catch {
		throw new Error(`verify 找不到路径：${requestedPath}`);
	}
	if (!isPathInside(projectRoot, targetPath)) throw new Error("verify 只能检查当前项目中的文件。");
	const targetStat = await stat(targetPath);
	const targetIsFile = targetStat.isFile();
	const targetDirectory = targetIsFile ? path.dirname(targetPath) : targetPath;
	let directory = targetDirectory;
	const hint = targetIsFile ? languageHint(targetPath) : undefined;

	while (true) {
		const languages = await markerLanguages(directory);
		const language = hint ? languages.find((candidate) => candidate === hint) : languages[0];
		if (language) {
			return {
				projectRoot,
				workspaceRoot: directory,
				targetPath,
				relativeTarget: path.relative(directory, targetPath).replaceAll("\\", "/") || ".",
				targetIsFile,
				language,
				standalone: false,
			};
		}
		if (directory === projectRoot) break;
		const parent = path.dirname(directory);
		if (!isPathInside(projectRoot, parent)) break;
		directory = parent;
	}
	if (targetIsFile && hint === "python") {
		return {
			projectRoot,
			workspaceRoot: targetDirectory,
			targetPath,
			relativeTarget: path.basename(targetPath),
			targetIsFile,
			language: hint,
			standalone: true,
		};
	}
	throw new Error("verify 没有识别到 TypeScript/JavaScript、Python 或 Go 项目。请把 path 指向项目文件或目录。");
}

async function readPackageJson(workspaceRoot: string): Promise<PackageJson> {
	const content = await readFile(path.join(workspaceRoot, "package.json"), "utf8");
	const parsed: unknown = JSON.parse(content);
	if (typeof parsed !== "object" || parsed === null) return { scripts: {} };
	const scriptsValue = Reflect.get(parsed, "scripts");
	const scripts: Record<string, string> = {};
	if (typeof scriptsValue === "object" && scriptsValue !== null) {
		for (const [name, value] of Object.entries(scriptsValue)) {
			if (typeof value === "string") scripts[name] = value;
		}
	}
	const packageManager = Reflect.get(parsed, "packageManager");
	return { scripts, ...(typeof packageManager === "string" ? { packageManager } : {}) };
}

async function detectPackageManager(workspace: VerifyWorkspace, packageJson: PackageJson): Promise<string> {
	const declared = packageJson.packageManager?.split("@")[0];
	if (declared && ["npm", "pnpm", "yarn", "bun"].includes(declared)) return declared;
	let directory = workspace.workspaceRoot;
	while (true) {
		if (await fileExists(path.join(directory, "package-lock.json"))) return "npm";
		if (await fileExists(path.join(directory, "pnpm-lock.yaml"))) return "pnpm";
		if (await fileExists(path.join(directory, "yarn.lock"))) return "yarn";
		if (
			(await fileExists(path.join(directory, "bun.lock"))) ||
			(await fileExists(path.join(directory, "bun.lockb")))
		) {
			return "bun";
		}
		if (directory === workspace.projectRoot) break;
		const parent = path.dirname(directory);
		if (!isPathInside(workspace.projectRoot, parent)) break;
		directory = parent;
	}
	return "npm";
}

function packageScriptCommand(
	manager: string,
	workspaceRoot: string,
	label: string,
	script: string,
	extraArgs: string[] = [],
): VerifyCommand {
	return {
		label,
		command: manager,
		args: ["run", script, ...(extraArgs.length > 0 ? ["--", ...extraArgs] : [])],
		cwd: workspaceRoot,
	};
}

async function findExecutableUpward(workspace: VerifyWorkspace, relativePath: string): Promise<string | undefined> {
	let directory = workspace.workspaceRoot;
	while (true) {
		const candidate = path.join(directory, relativePath);
		if (await fileExists(candidate)) return candidate;
		if (directory === workspace.projectRoot) break;
		const parent = path.dirname(directory);
		if (!isPathInside(workspace.projectRoot, parent)) break;
		directory = parent;
	}
	return undefined;
}

function testStem(filePath: string): string {
	return path
		.basename(filePath)
		.replace(/\.(test|spec)$/i, "")
		.replace(/\.[^.]+$/, "");
}

function isTestFile(filePath: string): boolean {
	return TEST_FILE_PATTERN.test(path.basename(filePath)) || /(^|[/\\])(test|tests|__tests__)([/\\]|$)/i.test(filePath);
}

async function relatedJavaScriptTests(workspace: VerifyWorkspace): Promise<string[]> {
	if (workspace.targetIsFile && isTestFile(workspace.targetPath)) return [workspace.relativeTarget];
	if (!workspace.targetIsFile || workspace.relativeTarget === ".") return [];
	const stem = testStem(workspace.targetPath);
	return (
		await glob([`**/${stem}.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`, `**/${stem}-test.{ts,tsx,js,jsx}`], {
			cwd: workspace.workspaceRoot,
			nodir: true,
			ignore: IGNORED_PATHS,
		})
	)
		.slice(0, 20)
		.map((filePath) => filePath.replaceAll("\\", "/"))
		.sort();
}

async function planJavaScript(workspace: VerifyWorkspace, operation: VerifyOperation): Promise<VerifyPlan> {
	const packageJson = await readPackageJson(workspace.workspaceRoot);
	const manager = await detectPackageManager(workspace, packageJson);
	const checks: PlannedVerifyCheck[] = [];
	const notes: string[] = [];
	const typecheckScript = ["typecheck", "type-check", "check:types", "check-types"].find(
		(name) => packageJson.scripts[name] !== undefined,
	);
	if (operation === "auto" || operation === "typecheck") {
		let command: VerifyCommand | undefined;
		if (typecheckScript) {
			command = packageScriptCommand(manager, workspace.workspaceRoot, "TypeScript 类型检查", typecheckScript);
		} else if (
			(await fileExists(path.join(workspace.workspaceRoot, "tsconfig.json"))) ||
			(await fileExists(path.join(workspace.workspaceRoot, "jsconfig.json")))
		) {
			const localTsc = await findExecutableUpward(workspace, path.join("node_modules", "typescript", "bin", "tsc"));
			const tscPath = localTsc ?? bundledTscPath;
			command = {
				label: "TypeScript 类型检查",
				command: tscPath ? process.execPath : "tsc",
				args: [...(tscPath ? [tscPath] : []), "--noEmit", "--pretty", "false"],
				cwd: workspace.workspaceRoot,
			};
		}
		if (command) {
			checks.push({
				id: "typecheck",
				label: command.label,
				commands: [command],
				missingHint: "没有找到 TypeScript 检查器。请先安装项目依赖。",
			});
		} else if (operation === "typecheck") {
			notes.push("没有找到 typecheck 脚本、tsconfig.json 或 jsconfig.json。");
		}
	}

	if (operation === "auto" || operation === "test") {
		const testScript = packageJson.scripts.test;
		const relatedTests = await relatedJavaScriptTests(workspace);
		if (testScript) {
			if (operation === "test" || relatedTests.length > 0) {
				const targets =
					relatedTests.length > 0
						? relatedTests
						: workspace.targetIsFile || workspace.relativeTarget === "."
							? []
							: [workspace.relativeTarget];
				checks.push({
					id: "test",
					label: relatedTests.length > 0 ? `相关测试（${relatedTests.length} 个文件）` : "项目测试",
					commands: [packageScriptCommand(manager, workspace.workspaceRoot, "项目测试", "test", targets)],
					missingHint: `没有找到包管理器 ${manager}。请先安装并确认它已加入 PATH。`,
				});
			} else {
				notes.push("没有找到可安全定位的相关测试，因此没有自动运行整个测试套件；需要时使用 operation=test。");
			}
		} else {
			notes.push(
				operation === "test"
					? "package.json 没有 test 脚本。"
					: "package.json 没有 test 脚本，因此 auto 只执行其他可用检查。",
			);
		}
	}

	if (operation === "lint") {
		if (packageJson.scripts.lint) {
			checks.push({
				id: "lint",
				label: "代码规范检查",
				commands: [packageScriptCommand(manager, workspace.workspaceRoot, "代码规范检查", "lint")],
				missingHint: `没有找到包管理器 ${manager}。请先安装并确认它已加入 PATH。`,
			});
		} else {
			notes.push("package.json 没有 lint 脚本。");
		}
	}
	return { workspace, checks, notes };
}

function pythonInterpreterCommands(workspaceRoot: string, label: string, args: string[]): VerifyCommand[] {
	return [
		{ label, command: "python", args, cwd: workspaceRoot },
		{ label, command: "python3", args, cwd: workspaceRoot },
		{ label, command: "py", args: ["-3", ...args], cwd: workspaceRoot },
	];
}

function pythonCommands(workspaceRoot: string, label: string, module: string, args: string[]): VerifyCommand[] {
	return pythonInterpreterCommands(workspaceRoot, label, ["-m", module, ...args]);
}

async function relatedPythonTests(workspace: VerifyWorkspace): Promise<string[]> {
	if (workspace.targetIsFile && isTestFile(workspace.targetPath)) return [workspace.relativeTarget];
	if (!workspace.targetIsFile || workspace.relativeTarget === ".") return [];
	const stem = testStem(workspace.targetPath);
	return (
		await glob([`**/test_${stem}.py`, `**/${stem}_test.py`], {
			cwd: workspace.workspaceRoot,
			nodir: true,
			ignore: [...IGNORED_PATHS, "**/.venv/**", "**/venv/**"],
		})
	)
		.slice(0, 20)
		.map((filePath) => filePath.replaceAll("\\", "/"))
		.sort();
}

async function planPython(workspace: VerifyWorkspace, operation: VerifyOperation): Promise<VerifyPlan> {
	const checks: PlannedVerifyCheck[] = [];
	const notes: string[] = [];
	if (operation === "auto" || operation === "typecheck") {
		if (workspace.standalone && workspace.targetIsFile) {
			checks.push({
				id: "typecheck",
				label: "Python 语法检查",
				commands: pythonInterpreterCommands(workspace.workspaceRoot, "Python 语法检查", [
					"-c",
					PYTHON_SYNTAX_SCRIPT,
					workspace.relativeTarget,
				]),
				missingHint: "没有找到 Python 解释器，无法执行安全语法检查。",
			});
		}
		const args = workspace.relativeTarget === "." ? [] : [workspace.relativeTarget];
		checks.push({
			id: "typecheck",
			label: "Python 类型检查",
			commands: [
				{ label: "Python 类型检查", command: "basedpyright", args, cwd: workspace.workspaceRoot },
				{ label: "Python 类型检查", command: "pyright", args, cwd: workspace.workspaceRoot },
			],
			missingHint: "没有找到 Python 类型检查器。请在项目环境运行：pip install basedpyright",
		});
	}
	if (operation === "auto" || operation === "test") {
		const relatedTests = await relatedPythonTests(workspace);
		if (operation === "test" || relatedTests.length > 0) {
			const targets =
				relatedTests.length > 0
					? relatedTests
					: workspace.targetIsFile || workspace.relativeTarget === "."
						? []
						: [workspace.relativeTarget];
			checks.push({
				id: "test",
				label: relatedTests.length > 0 ? `相关测试（${relatedTests.length} 个文件）` : "Python 测试",
				commands: pythonCommands(workspace.workspaceRoot, "Python 测试", "pytest", ["-q", ...targets]),
				missingHint: "没有找到 pytest。请在项目环境运行：pip install pytest",
			});
		} else {
			notes.push("没有找到可安全定位的相关测试，因此没有自动运行整个测试套件；需要时使用 operation=test。");
		}
	}
	if (operation === "lint") {
		checks.push({
			id: "lint",
			label: "Python 代码规范检查",
			commands: [
				{
					label: "Python 代码规范检查",
					command: "ruff",
					args: ["check", workspace.relativeTarget],
					cwd: workspace.workspaceRoot,
				},
			],
			missingHint: "没有找到 ruff。请在项目环境运行：pip install ruff",
		});
	}
	return { workspace, checks, notes };
}

function goTarget(workspace: VerifyWorkspace): string {
	if (workspace.relativeTarget === ".") return "./...";
	const directory = workspace.targetIsFile ? path.posix.dirname(workspace.relativeTarget) : workspace.relativeTarget;
	return directory === "." ? "." : `./${directory}`;
}

function planGo(workspace: VerifyWorkspace, operation: VerifyOperation): VerifyPlan {
	const checks: PlannedVerifyCheck[] = [];
	const notes: string[] = [];
	const target = goTarget(workspace);
	if (operation === "auto" || operation === "test") {
		checks.push({
			id: "test",
			label: "Go 编译与测试",
			commands: [{ label: "Go 编译与测试", command: "go", args: ["test", target], cwd: workspace.workspaceRoot }],
			missingHint: "没有找到 go 命令。请先安装 Go，并确认 go 已加入 PATH。",
		});
	}
	if (operation === "typecheck" || operation === "lint") {
		checks.push({
			id: operation,
			label: "Go 静态检查",
			commands: [{ label: "Go 静态检查", command: "go", args: ["vet", target], cwd: workspace.workspaceRoot }],
			missingHint: "没有找到 go 命令。请先安装 Go，并确认 go 已加入 PATH。",
		});
	}
	return { workspace, checks, notes };
}

export async function createVerifyPlan(request: VerifyRequest, cwd: string): Promise<VerifyPlan> {
	const workspace = await resolveVerifyWorkspace(cwd, request.path);
	switch (workspace.language) {
		case "typescript":
			return planJavaScript(workspace, request.operation);
		case "python":
			return planPython(workspace, request.operation);
		case "go":
			return planGo(workspace, request.operation);
	}
}
