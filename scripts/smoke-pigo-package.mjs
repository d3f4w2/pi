#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
	buildPigoPackage,
	PIGO_PACKAGE_NAME,
	validatePigoPackageFiles,
	validatePigoPackageManifest,
} from "./pigo-package.mjs";
import { resolveNpmCliPath } from "./npm-cli.mjs";

export { resolveNpmCliPath } from "./npm-cli.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export function getGlobalBinDirectory(prefix, platform = process.platform) {
	return platform === "win32" ? prefix : join(prefix, "bin");
}

export function createIsolatedPigoEnvironment(
	binDirectory,
	configDirectory,
	baseEnvironment = process.env,
	platform = process.platform,
) {
	const environment = { ...baseEnvironment };
	const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const separator = platform === "win32" ? ";" : ":";
	environment[pathKey] = `${binDirectory}${environment[pathKey] ? `${separator}${environment[pathKey]}` : ""}`;
	environment.PI_CODING_AGENT_DIR = configDirectory;
	environment.PI_OFFLINE = "1";
	environment.PI_SKIP_VERSION_CHECK = "1";
	environment.PI_TELEMETRY = "0";
	return environment;
}

function normalizePackedPath(path) {
	return path.replaceAll("\\", "/").replace(/^package\//, "");
}

function canonicalJson(value) {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
		.join(",")}}`;
}

function privateWorkspaceReceiptDirectory(agentDirectory, workspaceRoot, platform = process.platform) {
	const pathImplementation = platform === "win32" ? win32 : posix;
	const portableRoot = pathImplementation.resolve(workspaceRoot).replaceAll("\\", "/");
	const normalizedRoot = platform === "win32" ? portableRoot.toLowerCase() : portableRoot;
	const workspaceDigest = createHash("sha256").update(normalizedRoot).digest("hex");
	return join(agentDirectory, "runs", "by-workspace", workspaceDigest);
}

export function createSmokeReceiptEnvelope() {
	const receipt = {
		schemaVersion: 1,
		runId: "pigo-package-smoke",
		startedAt: "2026-08-12T00:00:00.000Z",
		finishedAt: "2026-08-12T00:00:00.001Z",
		durationMs: 1,
		contract: {
			sha256: "a".repeat(64),
			task: { sha256: "b".repeat(64), utf8Bytes: 5 },
			scope: ["."],
			verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
			budget: { timeoutSeconds: 60, maxTokens: 1000, maxToolCalls: 10 },
		},
		workspace: {
			coverage: "git-tracked-and-unignored",
			headBefore: null,
			headAfter: null,
			headChanged: false,
			beforeDigest: "c".repeat(64),
			afterDigest: "c".repeat(64),
			changed: [],
			scopeViolations: [],
		},
		execution: {
			exitCode: 0,
			terminationReason: "completed",
			turns: 1,
			toolCalls: {},
			toolErrors: 0,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				cost: 0,
			},
			protocolErrors: 0,
		},
		verification: [],
		result: { outcome: "completed" },
	};
	return {
		receipt,
		integrity: {
			algorithm: "sha256",
			canonicalization: "json-sorted-keys-v1",
			digest: createHash("sha256").update(canonicalJson(receipt)).digest("hex"),
		},
	};
}

export function validatePackedPigoMetadata(metadata) {
	const errors = [];
	if (metadata.name !== PIGO_PACKAGE_NAME) {
		errors.push(`packed package name must be ${PIGO_PACKAGE_NAME}`);
	}
	if (typeof metadata.version !== "string" || !metadata.version.trim()) {
		errors.push("packed package must have a version");
	}
	const files = Array.isArray(metadata.files)
		? metadata.files
				.map((file) => (typeof file?.path === "string" ? normalizePackedPath(file.path) : undefined))
				.filter((path) => path !== undefined)
		: [];
	errors.push(...validatePigoPackageFiles(files));
	return errors;
}

export function validateDoctorPayload(payload, options = {}) {
	const errors = [];
	if (!payload || typeof payload !== "object") {
		return ["doctor output must be a JSON object"];
	}
	if (Object.hasOwn(payload, "env")) {
		errors.push("doctor output must not expose an environment map");
	}
	const serialized = JSON.stringify(payload);
	if (/Bearer\s+|\bsk-[0-9A-Za-z_-]{4,}/i.test(serialized)) {
		errors.push("doctor output must not expose a secret");
	}
	if (payload.version !== 1 || payload.product?.name !== "pigo" || typeof payload.product?.version !== "string") {
		errors.push("doctor output must identify the versioned pigo product");
	}
	if (!Array.isArray(payload.report?.findings) || typeof payload.report?.summary !== "object") {
		errors.push("doctor output must contain report findings and a summary");
	}
	if (options.requireSystemDirectoryWarning) {
		const warning = payload.report?.findings?.find(
			(finding) =>
				finding?.id === "cwd" &&
				finding?.severity === "warning" &&
				/System32/i.test(String(finding.detail)) &&
				/pigo/i.test(String(finding.fix)),
		);
		if (!warning) {
			errors.push("doctor output must warn when launched from Windows System32");
		}
	}
	return errors;
}

export function validateInteractiveCommandContract(commands) {
	if (!Array.isArray(commands)) {
		return ["get_commands output must contain a commands array"];
	}
	const extensionCommands = commands.filter((command) => command?.source === "extension");
	const runCommands = extensionCommands.filter((command) => command.name === "run");
	const ciCommands = extensionCommands.filter((command) => command.name === "ci");
	const errors = [];
	if (runCommands.length !== 1) {
		errors.push(`installed product must expose exactly one extension /run command, found ${runCommands.length}`);
	}
	if (ciCommands.length !== 0) {
		errors.push(`installed product must not expose an extension /ci command, found ${ciCommands.length}`);
	}
	return errors;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		input: options.input,
		stdio: options.capture === false ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		timeout: options.timeoutMs ?? 120000,
	});
	if (result.error) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}: ${result.error.message}`, { cause: result.error });
	}
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(
			`Command failed (${String(result.status)}): ${command} ${args.join(" ")}${output ? `\n${output}` : ""}`,
		);
	}
	return result;
}

function runNpm(args, options) {
	const npmExecutable = resolveNpmCliPath();
	if (npmExecutable) {
		return run(process.execPath, [npmExecutable, ...args], options);
	}
	if (process.platform === "win32") {
		const shell = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
		const command = ["npm", ...args]
			.map((arg) => (/\s/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg))
			.join(" ");
		return run(shell, ["/d", "/s", "/c", `"${command}"`], options);
	}
	return run("npm", args, options);
}

function runPigo(args, options) {
	if (process.platform === "win32") {
		const shell = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
		return run(shell, ["/d", "/s", "/c", ["pigo", ...args].join(" ")], options);
	}
	return run("pigo", args, options);
}

function assertNoErrors(errors, label) {
	if (errors.length > 0) {
		throw new Error(`${label}:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

function parsePackOutput(stdout) {
	const parsed = JSON.parse(stdout);
	const metadata = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (!metadata || typeof metadata.filename !== "string") {
		throw new Error("npm pack did not return package metadata");
	}
	return metadata;
}

function isInsidePath(child, parent) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function removeSmokeDirectory(directory) {
	const temporaryRoot = resolve(tmpdir());
	const target = resolve(directory);
	if (!isInsidePath(target, temporaryRoot) || !basename(target).startsWith("pigo-package-smoke-")) {
		throw new Error(`Refusing unsafe smoke directory cleanup: ${target}`);
	}
	rmSync(target, { force: true, recursive: true });
}

function expectedInstalledPackageDirectory(prefix) {
	return process.platform === "win32"
		? join(prefix, "node_modules", PIGO_PACKAGE_NAME)
		: join(prefix, "lib", "node_modules", PIGO_PACKAGE_NAME);
}

function verifyCommandResolution(prefix, environment, cwd) {
	const expectedBin = getGlobalBinDirectory(prefix);
	if (process.platform === "win32") {
		const result = run("where.exe", ["pigo"], { cwd, env: environment });
		const first = result.stdout.split(/\r?\n/).find(Boolean);
		const resolved = first ? resolve(first) : undefined;
		const expectedDirectory = resolve(expectedBin).toLowerCase();
		const acceptedNames = new Set(["pigo", "pigo.cmd", "pigo.exe"]);
		if (
			!resolved ||
			dirname(resolved).toLowerCase() !== expectedDirectory ||
			!acceptedNames.has(basename(resolved).toLowerCase())
		) {
			throw new Error(`pigo resolved outside the isolated prefix: ${first ?? "not found"}`);
		}
		if (existsSync(join(expectedBin, "pi.cmd"))) {
			throw new Error("legacy pi.cmd was installed beside pigo.cmd");
		}
		return;
	}
	if (!existsSync(join(expectedBin, "pigo"))) {
		throw new Error(`isolated pigo executable is missing from ${expectedBin}`);
	}
}

function parseJsonOutput(stdout, label) {
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new Error(`${label} did not return valid JSON`, { cause: error });
	}
}

export function smokePigoPackage(options = {}) {
	const smokeRoot = mkdtempSync(join(tmpdir(), "pigo-package-smoke-"));
	const stagingDirectory = join(smokeRoot, "package");
	const tarballDirectory = join(smokeRoot, "tarballs");
	const prefix = join(smokeRoot, "global prefix");
	const configDirectory = join(smokeRoot, "config");
	const normalDirectory = join(smokeRoot, "workspace");
	const spacedDirectory = join(smokeRoot, "workspace with spaces");
	try {
		mkdirSync(tarballDirectory, { recursive: true });
		mkdirSync(configDirectory, { recursive: true });
		mkdirSync(normalDirectory, { recursive: true });
		mkdirSync(spacedDirectory, { recursive: true });
		run("git", ["init", "--quiet"], { cwd: normalDirectory, timeoutMs: 30000 });
		buildPigoPackage(stagingDirectory);

		const packResult = runNpm(
			["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory],
			{ cwd: stagingDirectory, timeoutMs: 120000 },
		);
		const packed = parsePackOutput(packResult.stdout);
		assertNoErrors(validatePackedPigoMetadata(packed), "Packed Pigo metadata is invalid");
		const tarball = join(tarballDirectory, packed.filename);

		runNpm(["install", "-g", "--prefix", prefix, "--ignore-scripts", tarball], {
			cwd: normalDirectory,
			timeoutMs: 300000,
		});
		const installedManifestPath = join(expectedInstalledPackageDirectory(prefix), "package.json");
		if (!existsSync(installedManifestPath)) {
			throw new Error(`installed product manifest is missing: ${installedManifestPath}`);
		}
		assertNoErrors(
			validatePigoPackageManifest(JSON.parse(readFileSync(installedManifestPath, "utf8"))),
			"Installed Pigo manifest is invalid",
		);

		const binDirectory = getGlobalBinDirectory(prefix);
		const environment = createIsolatedPigoEnvironment(binDirectory, configDirectory);
		verifyCommandResolution(prefix, environment, normalDirectory);

		const version = runPigo(["--version"], { cwd: normalDirectory, env: environment, timeoutMs: 30000 }).stdout.trim();
		if (version !== packed.version) {
			throw new Error(`pigo --version returned ${version}, expected ${packed.version}`);
		}
		const help = runPigo(["--help"], { cwd: spacedDirectory, env: environment, timeoutMs: 30000 }).stdout;
		if (!/Usage:\s+pigo\b/.test(help) || !help.includes("pigo doctor [--json]")) {
			throw new Error("pigo --help is missing the product usage or doctor command");
		}
		const runHelp = runPigo(["run", "--help"], {
			cwd: spacedDirectory,
			env: environment,
			timeoutMs: 30000,
		}).stdout;
		if (!runHelp.includes("pigo run <task>") || !runHelp.includes("--check-receipt")) {
			throw new Error("pigo run --help is missing the verifiable-run contract");
		}
		const ciHelp = runPigo(["ci", "--help"], {
			cwd: spacedDirectory,
			env: environment,
			timeoutMs: 30000,
		}).stdout;
		if (!ciHelp.includes("pigo ci [receipt-or-directory") || !ciHelp.includes("offline CI policy")) {
			throw new Error("pigo ci --help is missing the receipt-native CI contract");
		}
		const receiptPath = join(normalDirectory, "smoke-receipt.json");
		writeFileSync(receiptPath, `${JSON.stringify(createSmokeReceiptEnvelope())}\n`, "utf8");
		const ciReport = parseJsonOutput(
			runPigo(["ci", receiptPath, "--json"], {
				cwd: spacedDirectory,
				env: environment,
				timeoutMs: 30000,
			}).stdout,
			"pigo ci --json",
		);
		if (ciReport.schemaVersion !== 1 || ciReport.passed !== true || ciReport.summary?.passed !== 1) {
			throw new Error("pigo ci did not accept the installed smoke receipt");
		}
		const workspaceRoot = run("git", ["rev-parse", "--show-toplevel"], {
			cwd: normalDirectory,
			timeoutMs: 30000,
		}).stdout.trim();
		const privateReceiptDirectory = privateWorkspaceReceiptDirectory(configDirectory, workspaceRoot);
		mkdirSync(privateReceiptDirectory, { recursive: true });
		writeFileSync(
			join(privateReceiptDirectory, "automatic-smoke-receipt.json"),
			`${JSON.stringify(createSmokeReceiptEnvelope())}\n`,
			"utf8",
		);
		writeFileSync(join(normalDirectory, "pigo.ci.json"), '{"version":1}\n', "utf8");
		const automaticCiReport = parseJsonOutput(
			runPigo(["ci", "--json"], {
				cwd: normalDirectory,
				env: environment,
				timeoutMs: 30000,
			}).stdout,
			"zero-input pigo ci --json",
		);
		if (
			automaticCiReport.passed !== true ||
			automaticCiReport.summary?.receipts !== 1 ||
			automaticCiReport.policy?.source !== "pigo.ci.json"
		) {
			throw new Error("zero-input pigo ci did not discover the current project receipt and policy");
		}

		const doctor = parseJsonOutput(
			runPigo(["doctor", "--json"], { cwd: normalDirectory, env: environment, timeoutMs: 30000 }).stdout,
			"pigo doctor --json",
		);
		assertNoErrors(validateDoctorPayload(doctor), "Installed Pigo doctor output is invalid");

		const commandOutput = runPigo(["--mode", "rpc", "--no-session"], {
			cwd: normalDirectory,
			env: environment,
			input: `${JSON.stringify({ id: "installed-command-contract", type: "get_commands" })}\n`,
			timeoutMs: 30000,
		}).stdout;
		const commandResponse = commandOutput
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => parseJsonOutput(line, "pigo RPC output line"))
			.find((message) => message.id === "installed-command-contract" && message.command === "get_commands");
		if (!commandResponse?.success) {
			throw new Error("installed pigo RPC did not return get_commands successfully");
		}
		assertNoErrors(
			validateInteractiveCommandContract(commandResponse.data?.commands),
			"Installed Pigo interactive command contract is invalid",
		);

		const listModels = runPigo(["--list-models"], {
			cwd: spacedDirectory,
			env: environment,
			timeoutMs: 60000,
		}).stdout;
		if (!listModels.trim()) {
			throw new Error("pigo --list-models produced no output");
		}

		let systemDoctorChecked = false;
		if (process.platform === "win32" && existsSync("C:\\Windows\\System32")) {
			const systemDoctor = parseJsonOutput(
				runPigo(["doctor", "--json"], {
					cwd: "C:\\Windows\\System32",
					env: environment,
					timeoutMs: 30000,
				}).stdout,
				"pigo doctor --json from System32",
			);
			assertNoErrors(
				validateDoctorPayload(systemDoctor, { requireSystemDirectoryWarning: true }),
				"System32 doctor output is invalid",
			);
			systemDoctorChecked = true;
		}

		return {
			name: packed.name,
			version: packed.version,
			packedFiles: packed.files.length,
			packedBytes: packed.size,
			unpackedBytes: packed.unpackedSize,
			systemDoctorChecked,
		};
	} finally {
		if (options.keep) {
			console.log(`Kept smoke artifacts at ${smokeRoot}`);
		} else {
			removeSmokeDirectory(smokeRoot);
		}
	}
}

function main() {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--keep")) {
		throw new Error("Usage: node scripts/smoke-pigo-package.mjs [--keep]");
	}
	const result = smokePigoPackage({ keep: args.includes("--keep") });
	console.log(
		`Verified ${result.name}@${result.version}: ${result.packedFiles} files, ${result.packedBytes} packed bytes, ${result.unpackedBytes} unpacked bytes${result.systemDoctorChecked ? ", including System32" : ""}.`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
