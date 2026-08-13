import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "../config.ts";
import { type CiReceiptFile, discoverCiReceiptFiles, selectLatestCiReceiptFile } from "./ci-files.ts";
import {
	type CiReceiptInput,
	createDefaultCiPolicy,
	evaluateCiGate,
	formatCiGateReport,
	parseCiPolicyText,
} from "./ci-policy.ts";
import { getWorkspaceRunDirectory } from "./project-runs.ts";
import { verifyRunReceiptText } from "./run-receipt.ts";
import { getGitWorkspaceRoot } from "./run-workspace.ts";

interface ParsedCiArguments {
	help: boolean;
	json: boolean;
	all: boolean;
	policyPath?: string;
	inputs: string[];
}

export interface CiCommandDependencies {
	cwd: () => string;
	readTextFile: (filePath: string) => Promise<string>;
	pathExists: (filePath: string) => Promise<boolean>;
	getWorkspaceRoot: (cwd: string) => Promise<string>;
	defaultReceiptDirectory: (workspaceRoot: string) => string;
	discoverReceiptFiles: (inputs: readonly string[], cwd: string) => Promise<CiReceiptFile[]>;
	writeStdout: (value: string) => void;
	writeStderr: (value: string) => void;
	setExitCode: (value: number) => void;
}

function optionValue(args: readonly string[], index: number, inlineValue: string | undefined, option: string): string {
	if (inlineValue !== undefined) {
		if (inlineValue.length === 0) throw new Error(`${option} requires a value.`);
		return inlineValue;
	}
	const value = args[index + 1];
	if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
	return value;
}

export function parseCiArguments(args: readonly string[]): ParsedCiArguments {
	const inputs: string[] = [];
	let help = false;
	let json = false;
	let all = false;
	let policyPath: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--all") {
			all = true;
			continue;
		}
		if (argument.startsWith("--policy")) {
			const equals = argument.indexOf("=");
			const option = equals === -1 ? argument : argument.slice(0, equals);
			if (option !== "--policy") throw new Error(`Unknown option "${option}".`);
			const value = optionValue(args, index, equals === -1 ? undefined : argument.slice(equals + 1), option);
			if (equals === -1) index += 1;
			policyPath = value;
			continue;
		}
		if (argument.startsWith("-")) throw new Error(`Unknown option "${argument}".`);
		inputs.push(argument);
	}
	return { help, json, all, ...(policyPath === undefined ? {} : { policyPath }), inputs };
}

function printCiHelp(write: (value: string) => void): void {
	write(`pigo ci [receipt-or-directory...] [options]

Validate pigo run receipts and enforce a deterministic, offline CI policy.
With no receipt input, validate the latest receipt stored for the current Git project.

Options:
  --all            Validate every stored receipt for the current project instead of the latest
  --policy <file>  Load a strict version-1 JSON policy
  --json           Write only the machine-readable gate report to stdout
  -h, --help       Show this help

Policy default:
  pigo.ci.json in the project root, then the built-in strict policy

Exit codes:
  0  Every receipt and aggregate policy passed
  1  Receipt integrity or policy gate failed
  2  Usage, policy, discovery, or required input failed

Examples:
  pigo ci
  pigo ci --all
  pigo ci artifacts/runs
  pigo ci run-a.json run-b.json --policy pigo.ci.json
  pigo ci artifacts/runs --json
`);
}

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

function renderPath(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
		? relative.split(path.sep).join("/")
		: filePath.split(path.sep).join("/");
}

const defaultDependencies: CiCommandDependencies = {
	cwd: () => process.cwd(),
	readTextFile: (filePath) => readFile(filePath, "utf8"),
	pathExists,
	getWorkspaceRoot: getGitWorkspaceRoot,
	defaultReceiptDirectory: (workspaceRoot) => getWorkspaceRunDirectory(getAgentDir(), workspaceRoot),
	discoverReceiptFiles: discoverCiReceiptFiles,
	writeStdout: (value) => process.stdout.write(value),
	writeStderr: (value) => process.stderr.write(value),
	setExitCode: (value) => {
		process.exitCode = value;
	},
};

export async function runCiCommand(
	args: readonly string[],
	dependencies: CiCommandDependencies = defaultDependencies,
): Promise<number> {
	try {
		const parsed = parseCiArguments(args);
		if (parsed.help) {
			printCiHelp(dependencies.writeStdout);
			dependencies.setExitCode(0);
			return 0;
		}
		if (parsed.all && parsed.inputs.length > 0) {
			throw new Error("--all cannot be combined with explicit receipt inputs.");
		}
		const cwd = dependencies.cwd();
		let workspaceRoot: string | undefined;
		if (parsed.inputs.length === 0) {
			try {
				workspaceRoot = await dependencies.getWorkspaceRoot(cwd);
			} catch {
				throw new Error(
					"Zero-input mode needs a Git project. Run pigo ci inside a Git project or pass a receipt path.",
				);
			}
		}
		const automaticPolicyPath = path.join(workspaceRoot ?? cwd, "pigo.ci.json");
		const policyPath = parsed.policyPath
			? path.resolve(cwd, parsed.policyPath)
			: (await dependencies.pathExists(automaticPolicyPath))
				? automaticPolicyPath
				: undefined;
		const policy = policyPath
			? parseCiPolicyText(await dependencies.readTextFile(policyPath))
			: createDefaultCiPolicy();
		let files: CiReceiptFile[];
		if (workspaceRoot) {
			const receiptDirectory = dependencies.defaultReceiptDirectory(workspaceRoot);
			if (!(await dependencies.pathExists(receiptDirectory))) {
				throw new Error('No stored receipts for this project. Run pigo run "<task>" first.');
			}
			try {
				files = await dependencies.discoverReceiptFiles([receiptDirectory], cwd);
			} catch (error) {
				if (error instanceof Error && error.message === "No receipt JSON files were found.") {
					throw new Error('No stored receipts for this project. Run pigo run "<task>" first.');
				}
				throw error;
			}
			if (!parsed.all) files = [selectLatestCiReceiptFile(files)];
		} else {
			files = await dependencies.discoverReceiptFiles(parsed.inputs, cwd);
		}
		const inputs: CiReceiptInput[] = [];
		for (const file of files) {
			try {
				inputs.push({
					file: file.displayPath,
					envelope: verifyRunReceiptText(await dependencies.readTextFile(file.absolutePath)),
				});
			} catch (error) {
				inputs.push({ file: file.displayPath, error: error instanceof Error ? error.message : String(error) });
			}
		}
		const report = evaluateCiGate(inputs, policy, policyPath ? renderPath(policyPath, cwd) : "built-in:strict-v1");
		dependencies.writeStdout(parsed.json ? `${JSON.stringify(report)}\n` : formatCiGateReport(report));
		const exitCode = report.passed ? 0 : 1;
		dependencies.setExitCode(exitCode);
		return exitCode;
	} catch (error) {
		dependencies.writeStderr(`pigo ci: ${error instanceof Error ? error.message : String(error)}\n`);
		dependencies.setExitCode(2);
		return 2;
	}
}
