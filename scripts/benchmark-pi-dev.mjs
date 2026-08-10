import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const sourceCli = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const tsconfig = join(repoRoot, "tsconfig.json");

export function percentile(values, ratio) {
	if (values.length === 0) throw new Error("Cannot calculate a percentile for an empty sample.");
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function summarize(values) {
	if (values.length === 0) throw new Error("Cannot summarize an empty sample.");
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
	return {
		runs: sorted.length,
		minMs: sorted[0],
		medianMs: median,
		avgMs: avg,
		p95Ms: percentile(sorted, 0.95),
		maxMs: sorted[sorted.length - 1],
	};
}

export function compare(baseline, candidate) {
	return {
		medianSavedMs: baseline.medianMs - candidate.medianMs,
		medianImprovementPercent: ((baseline.medianMs - candidate.medianMs) / baseline.medianMs) * 100,
		medianSpeedup: baseline.medianMs / candidate.medianMs,
		p95SavedMs: baseline.p95Ms - candidate.p95Ms,
		p95ImprovementPercent: ((baseline.p95Ms - candidate.p95Ms) / baseline.p95Ms) * 100,
	};
}

function parsePositiveInteger(value, flag) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer.`);
	return parsed;
}

function parseArgs(argv) {
	const options = { runs: 7, warmup: 1, mode: "all", output: undefined };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--help" || flag === "-h") return { ...options, help: true };
		if (index + 1 >= argv.length) throw new Error(`Missing value for ${flag}.`);
		const value = argv[++index];
		if (flag === "--runs") options.runs = parsePositiveInteger(value, flag);
		else if (flag === "--warmup") options.warmup = parsePositiveInteger(value, flag);
		else if (flag === "--mode" && ["all", "version", "rpc"].includes(value)) options.mode = value;
		else if (flag === "--output") options.output = resolve(value);
		else throw new Error(`Unknown option: ${flag}.`);
	}
	if (options.runs < 1) throw new Error("--runs must be at least 1.");
	return options;
}

function launcherArguments(launcher, mode) {
	const prefix =
		launcher === "node-strip"
			? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", sourceCli]
			: [tsxCli, "--tsconfig", tsconfig, sourceCli];
	return mode === "version" ? [...prefix, "--version"] : [...prefix, "--mode", "rpc", "--no-session"];
}

function splitLines(buffer, onLine) {
	let remaining = buffer;
	for (;;) {
		const newline = remaining.indexOf("\n");
		if (newline < 0) return remaining;
		onLine(remaining.slice(0, newline).replace(/\r$/, ""));
		remaining = remaining.slice(newline + 1);
	}
}

async function measure(launcher, mode, environment) {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, launcherArguments(launcher, mode), {
			cwd: repoRoot,
			env: environment,
			stdio: [mode === "rpc" ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const startedAt = performance.now();
		let stdout = "";
		let stderr = "";
		let settled = false;
		const requestId = `benchmark-${process.pid}-${Date.now()}`;
		const timeout = setTimeout(() => finish(new Error(`${launcher} ${mode} timed out.`)), 30_000);

		const finish = (error, elapsedMs) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (!child.killed && child.exitCode === null) child.kill();
			if (error) reject(error);
			else resolvePromise(elapsedMs);
		};

		child.once("error", finish);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (mode !== "rpc") {
				stdout += chunk;
				return;
			}
			stdout = splitLines(stdout + chunk, (line) => {
				if (!line.trim()) return;
				try {
					const message = JSON.parse(line);
					if (message.type === "response" && message.id === requestId && message.success === true) {
						const elapsedMs = performance.now() - startedAt;
						child.stdin.end();
						finish(undefined, elapsedMs);
					}
				} catch {
					// Ignore non-protocol output; a missing response is reported by the timeout.
				}
			});
		});
		child.once("exit", (code) => {
			if (settled) return;
			if (mode === "version" && code === 0) finish(undefined, performance.now() - startedAt);
			else finish(new Error(`${launcher} ${mode} failed (${code ?? "unknown"}): ${stderr.trim()}`));
		});
		if (mode === "rpc") child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);
	});
}

async function runMode(mode, options, environment) {
	const samples = { tsx: [], nodeStrip: [] };
	const totalRuns = options.warmup + options.runs;
	for (let index = 0; index < totalRuns; index++) {
		const launchers = index % 2 === 0 ? ["tsx", "node-strip"] : ["node-strip", "tsx"];
		for (const launcher of launchers) {
			const elapsedMs = await measure(launcher, mode, environment);
			if (index >= options.warmup) {
				(launcher === "tsx" ? samples.tsx : samples.nodeStrip).push(elapsedMs);
				process.stdout.write(`${mode} ${launcher} ${elapsedMs.toFixed(1)}ms\n`);
			}
		}
	}
	const baseline = summarize(samples.tsx);
	const candidate = summarize(samples.nodeStrip);
	return { baseline, candidate, improvement: compare(baseline, candidate), samples };
}

function systemMetadata() {
	const cpu = cpus()[0];
	const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
	return {
		recordedAt: new Date().toISOString(),
		gitCommit: revision.status === 0 ? revision.stdout.trim() : "unknown",
		workingTreeDirty: status.status === 0 ? status.stdout.trim().length > 0 : undefined,
		platform: platform(),
		osRelease: release(),
		architecture: process.arch,
		cpu: cpu?.model ?? "unknown",
		logicalCpuCount: cpus().length,
		totalMemoryBytes: totalmem(),
		freeMemoryBytesAtStart: freemem(),
		node: process.version,
	};
}

function printResult(mode, result) {
	process.stdout.write(`\n${mode}\n`);
	process.stdout.write(`  tsx median/p95:        ${result.baseline.medianMs.toFixed(1)} / ${result.baseline.p95Ms.toFixed(1)} ms\n`);
	process.stdout.write(`  node-strip median/p95: ${result.candidate.medianMs.toFixed(1)} / ${result.candidate.p95Ms.toFixed(1)} ms\n`);
	process.stdout.write(`  median saved:          ${result.improvement.medianSavedMs.toFixed(1)} ms\n`);
	process.stdout.write(`  median improvement:    ${result.improvement.medianImprovementPercent.toFixed(1)}%\n`);
	process.stdout.write(`  median speedup:        ${result.improvement.medianSpeedup.toFixed(2)}x\n`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write("Usage: node scripts/benchmark-pi-dev.mjs [--runs 7] [--warmup 1] [--mode all|version|rpc] [--output result.json]\n");
		return;
	}
	const system = systemMetadata();
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-dev-benchmark-"));
	const agentDirectory = join(temporaryRoot, "agent");
	mkdirSync(agentDirectory, { recursive: true });
	const environment = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDirectory,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
	};
	try {
		const modes = options.mode === "all" ? ["version", "rpc"] : [options.mode];
		const results = {};
		for (const mode of modes) {
			results[mode] = await runMode(mode, options, environment);
			printResult(mode, results[mode]);
		}
		const report = {
			schemaVersion: 1,
			method: {
				baseline: "tsx source launcher",
				candidate: "Node native TypeScript strip-only source launcher",
				runs: options.runs,
				warmupRuns: options.warmup,
				offline: true,
				isolatedAgentDirectory: true,
				interleavedOrder: true,
			},
			system,
			results,
		};
		if (options.output) {
			mkdirSync(dirname(options.output), { recursive: true });
			writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
			process.stdout.write(`\nSaved ${options.output}\n`);
		}
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
