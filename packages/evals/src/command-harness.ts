import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHarness, type Harness, type HarnessContext, type SimpleHarnessResult } from "vitest-evals/harness";

export type CommandTaskAssertion =
	| { type: "stdoutIncludes"; value: string }
	| { type: "stderrIncludes"; value: string }
	| { type: "fileExists"; path: string }
	| { type: "fileEquals"; path: string; value: string }
	| { type: "fileContains"; path: string; value: string };

export type CommandTask = {
	id: string;
	prompt: string;
	fixture?: Record<string, string>;
	allowedWrites?: string[];
	assertions: CommandTaskAssertion[];
	timeoutMs?: number;
};

export type CommandAssertionResult = {
	assertion: CommandTaskAssertion;
	passed: boolean;
	message: string;
};

export type CommandTaskOutput = {
	id: string;
	passed: boolean;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	stdout: string;
	stderr: string;
	outputTruncated: boolean;
	changedFiles: string[];
	unexpectedWrites: string[];
	assertions: CommandAssertionResult[];
};

export type CommandHarnessOptions = {
	name: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	maxOutputBytes?: number;
	defaultTimeoutMs?: number;
};

type ProcessResult = {
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	stdout: string;
	stderr: string;
	outputTruncated: boolean;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function validatePositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
}

function normalizeTaskPath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[a-zA-Z]:/.test(normalized) ||
		normalized.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new TypeError(`Task path must be a normalized project-relative path: ${path}`);
	}
	return normalized;
}

function normalizeAllowedWrite(path: string): string {
	const directory = path.endsWith("/") || path.endsWith("\\");
	const normalized = normalizeTaskPath(directory ? path.slice(0, -1) : path);
	return directory ? `${normalized}/` : normalized;
}

function isAllowedWrite(path: string, allowlist: readonly string[]): boolean {
	return allowlist.some((allowed) => (allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed));
}

async function createFixture(workspace: string, fixture: Readonly<Record<string, string>>): Promise<void> {
	for (const [path, content] of Object.entries(fixture)) {
		const normalized = normalizeTaskPath(path);
		const target = join(workspace, ...normalized.split("/"));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
}

async function collectManifest(directory: string, prefix = ""): Promise<Map<string, string>> {
	const manifest = new Map<string, string>();
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = await collectManifest(absolutePath, relativePath);
			for (const [path, digest] of nested) manifest.set(path, digest);
			continue;
		}
		if (entry.isSymbolicLink()) {
			manifest.set(relativePath, `symlink:${await readlink(absolutePath)}`);
			continue;
		}
		if (!entry.isFile()) {
			manifest.set(relativePath, `special:${entry.name}`);
			continue;
		}
		manifest.set(
			relativePath,
			createHash("sha256")
				.update(await readFile(absolutePath))
				.digest("hex"),
		);
	}
	return manifest;
}

function changedFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter((path) => before.get(path) !== after.get(path))
		.sort();
}

function appendBounded(
	chunks: Buffer[],
	chunk: Buffer,
	state: { bytes: number; truncated: boolean },
	maxBytes: number,
): void {
	const remaining = maxBytes - state.bytes;
	if (remaining <= 0) {
		state.truncated = true;
		return;
	}
	if (chunk.length <= remaining) {
		chunks.push(chunk);
		state.bytes += chunk.length;
		return;
	}
	chunks.push(chunk.subarray(0, remaining));
	state.bytes += remaining;
	state.truncated = true;
}

async function executeCommand(
	options: CommandHarnessOptions,
	workspace: string,
	task: CommandTask,
	signal: AbortSignal | undefined,
): Promise<ProcessResult> {
	const timeoutMs = task.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	validatePositiveInteger(timeoutMs, "timeoutMs");
	validatePositiveInteger(maxOutputBytes, "maxOutputBytes");

	const args = (options.args ?? ["-p", "{prompt}"]).map((arg) =>
		arg.replaceAll("{prompt}", task.prompt).replaceAll("{workspace}", workspace),
	);
	const child = spawn(options.command, args, {
		cwd: workspace,
		env: { ...process.env, ...options.env },
		shell: false,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const stdoutState = { bytes: 0, truncated: false };
	const stderrState = { bytes: 0, truncated: false };
	child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState, maxOutputBytes));
	child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, stderrState, maxOutputBytes));

	let timedOut = false;
	let aborted = false;
	let spawnError: Error | undefined;
	const terminate = () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
	};
	const abort = () => {
		aborted = true;
		terminate();
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, timeoutMs);

	const status = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (exitCode, exitSignal) => {
			resolve({ exitCode, signal: exitSignal });
		});
	});
	clearTimeout(timer);
	signal?.removeEventListener("abort", abort);
	if (spawnError) appendBounded(stderr, Buffer.from(spawnError.message), stderrState, maxOutputBytes);

	return {
		...status,
		timedOut,
		aborted,
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: Buffer.concat(stderr).toString("utf8"),
		outputTruncated: stdoutState.truncated || stderrState.truncated,
	};
}

async function evaluateAssertion(
	assertion: CommandTaskAssertion,
	workspace: string,
	result: Pick<ProcessResult, "stdout" | "stderr">,
): Promise<CommandAssertionResult> {
	if (assertion.type === "stdoutIncludes") {
		const passed = result.stdout.includes(assertion.value);
		return { assertion, passed, message: passed ? "stdout matched" : "stdout did not contain the expected value" };
	}
	if (assertion.type === "stderrIncludes") {
		const passed = result.stderr.includes(assertion.value);
		return { assertion, passed, message: passed ? "stderr matched" : "stderr did not contain the expected value" };
	}

	const normalized = normalizeTaskPath(assertion.path);
	const target = join(workspace, ...normalized.split("/"));
	try {
		const stat = await lstat(target);
		if (!stat.isFile()) return { assertion, passed: false, message: `${normalized} is not a regular file` };
		if (assertion.type === "fileExists") return { assertion, passed: true, message: `${normalized} exists` };
		const content = await readFile(target, "utf8");
		const passed = assertion.type === "fileEquals" ? content === assertion.value : content.includes(assertion.value);
		return {
			assertion,
			passed,
			message: passed ? `${normalized} matched` : `${normalized} did not match the expected content`,
		};
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { assertion, passed: false, message: `${normalized} does not exist` };
		}
		throw error;
	}
}

async function runCommandTask(
	input: CommandTask,
	signal: AbortSignal | undefined,
	setArtifact: HarnessContext["setArtifact"],
	options: CommandHarnessOptions,
): Promise<SimpleHarnessResult<CommandTaskOutput>> {
	const startedAt = performance.now();
	if (!input.id.trim()) throw new TypeError("Command task id must not be empty.");
	if (!input.prompt.trim()) throw new TypeError("Command task prompt must not be empty.");
	const allowedWrites = (input.allowedWrites ?? []).map(normalizeAllowedWrite);
	const root = await mkdtemp(join(tmpdir(), "pi-command-eval-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	try {
		await createFixture(workspace, input.fixture ?? {});
		const before = await collectManifest(workspace);
		const processResult = await executeCommand(options, workspace, input, signal);
		const after = await collectManifest(workspace);
		const changed = changedFiles(before, after);
		const unexpectedWrites = changed.filter((path) => !isAllowedWrite(path, allowedWrites));
		const assertions = await Promise.all(
			input.assertions.map((assertion) => evaluateAssertion(assertion, workspace, processResult)),
		);
		const output: CommandTaskOutput = {
			id: input.id,
			passed:
				processResult.exitCode === 0 &&
				!processResult.timedOut &&
				!processResult.aborted &&
				unexpectedWrites.length === 0 &&
				assertions.every((assertion) => assertion.passed),
			...processResult,
			changedFiles: changed,
			unexpectedWrites,
			assertions,
		};
		setArtifact("commandTask", output);
		return {
			output,
			events: [
				{ type: "message", role: "user", content: input.prompt },
				{ type: "message", role: "assistant", content: processResult.stdout || processResult.stderr },
			],
			timings: { totalMs: performance.now() - startedAt },
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

export function createCommandHarness(options: CommandHarnessOptions): Harness<CommandTask, CommandTaskOutput> {
	if (!options.name.trim()) throw new TypeError("Command harness name must not be empty.");
	if (!options.command.trim()) throw new TypeError("Command harness command must not be empty.");
	return createHarness<CommandTask, CommandTaskOutput>({
		name: options.name,
		run: ({ input, signal, setArtifact }) => runCommandTask(input, signal, setArtifact, options),
	});
}
