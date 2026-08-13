#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveNpmCliPath } from "./npm-cli.mjs";
import { PIGO_BIN_PATH, PIGO_PACKAGE_NAME, validatePigoPackageManifest } from "./pigo-package.mjs";
import { createIsolatedPigoEnvironment, validateDoctorPayload } from "./smoke-pigo-package.mjs";

const REGISTRY_URL = "https://registry.npmjs.org";
const RETRY_DELAY_MS = 5_000;
const RETRY_TIMEOUT_MS = 10 * 60 * 1_000;
const STABLE_SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function validatePublishedPigoMetadata(value, expectedVersion) {
	const errors = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return ["registry metadata must be an object"];
	}
	if (value.name !== PIGO_PACKAGE_NAME) errors.push(`registry package name must be ${PIGO_PACKAGE_NAME}`);
	if (value.version !== expectedVersion) errors.push(`registry version must be ${expectedVersion}`);
	if (typeof value.dist !== "object" || value.dist === null || Array.isArray(value.dist)) {
		errors.push("registry metadata must contain dist");
	} else {
		if (typeof value.dist.tarball !== "string" || !value.dist.tarball.startsWith("https://")) {
			errors.push("registry metadata must contain an HTTPS tarball URL");
		}
		if (typeof value.dist.integrity !== "string" || !value.dist.integrity.startsWith("sha512-")) {
			errors.push("registry metadata must contain sha512 integrity");
		}
	}
	return errors;
}

function parseArgs(args) {
	if (args.length !== 2 || args[0] !== "--version" || !STABLE_SEMVER_RE.test(args[1] ?? "")) {
		throw new Error("Usage: node scripts/smoke-published-pigo.mjs --version <x.y.z>");
	}
	return args[1];
}

function sleep(milliseconds) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForPublishedPigo(version) {
	const deadline = Date.now() + RETRY_TIMEOUT_MS;
	let lastError = "package is not available";
	do {
		try {
			const response = await fetch(`${REGISTRY_URL}/${PIGO_PACKAGE_NAME}/${version}`, {
				headers: { accept: "application/json" },
			});
			if (!response.ok) throw new Error(`registry returned ${response.status}`);
			const metadata = await response.json();
			const errors = validatePublishedPigoMetadata(metadata, version);
			if (errors.length > 0) throw new Error(errors.join("; "));
			const tarball = await fetch(metadata.dist.tarball, { method: "HEAD" });
			if (!tarball.ok) throw new Error(`tarball returned ${tarball.status}`);
			return metadata;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			if (Date.now() < deadline) await sleep(RETRY_DELAY_MS);
		}
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${PIGO_PACKAGE_NAME}@${version}: ${lastError}`);
}

function run(command, args, options) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		timeout: options.timeoutMs ?? 300_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
	}
	return result;
}

function installedPackageDirectory(prefix) {
	return process.platform === "win32"
		? join(prefix, "node_modules", PIGO_PACKAGE_NAME)
		: join(prefix, "lib", "node_modules", PIGO_PACKAGE_NAME);
}

function installedBinDirectory(prefix) {
	return process.platform === "win32" ? prefix : join(prefix, "bin");
}

function removeSmokeRoot(directory) {
	const target = resolve(directory);
	if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("pigo-published-smoke-")) {
		throw new Error(`Refusing unsafe published-package smoke cleanup: ${target}`);
	}
	rmSync(target, { force: true, recursive: true });
}

export async function smokePublishedPigo(version) {
	await waitForPublishedPigo(version);
	const smokeRoot = mkdtempSync(join(tmpdir(), "pigo-published-smoke-"));
	const prefix = join(smokeRoot, "global-prefix");
	const workspace = join(smokeRoot, "workspace");
	const configDirectory = join(smokeRoot, "config");
	try {
		mkdirSync(workspace, { recursive: true });
		mkdirSync(configDirectory, { recursive: true });
		const npmCliPath = resolveNpmCliPath();
		if (!npmCliPath) throw new Error("npm-cli.js was not found beside the active Node runtime");
		run(
			process.execPath,
			[npmCliPath, "install", "-g", "--prefix", prefix, "--ignore-scripts", `${PIGO_PACKAGE_NAME}@${version}`],
			{ cwd: smokeRoot, capture: false },
		);
		const packageDirectory = installedPackageDirectory(prefix);
		const manifestPath = join(packageDirectory, "package.json");
		if (!existsSync(manifestPath)) throw new Error(`installed manifest is missing: ${manifestPath}`);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const manifestErrors = validatePigoPackageManifest(manifest);
		if (manifestErrors.length > 0) throw new Error(`installed manifest is invalid: ${manifestErrors.join("; ")}`);
		const binDirectory = installedBinDirectory(prefix);
		const shimPath = join(binDirectory, process.platform === "win32" ? "pigo.cmd" : "pigo");
		if (!existsSync(shimPath)) throw new Error(`installed pigo command is missing: ${shimPath}`);
		const environment = createIsolatedPigoEnvironment(binDirectory, configDirectory);
		const cliPath = join(packageDirectory, PIGO_BIN_PATH);
		const actualVersion = run(process.execPath, [cliPath, "--version"], {
			cwd: workspace,
			env: environment,
			capture: true,
		}).stdout.trim();
		if (actualVersion !== version) throw new Error(`installed pigo returned ${actualVersion}; expected ${version}`);
		const doctor = JSON.parse(
			run(process.execPath, [cliPath, "doctor", "--json"], {
				cwd: workspace,
				env: environment,
				capture: true,
			}).stdout,
		);
		const doctorErrors = validateDoctorPayload(doctor);
		if (doctorErrors.length > 0) throw new Error(`installed doctor output is invalid: ${doctorErrors.join("; ")}`);
		return { name: PIGO_PACKAGE_NAME, version };
	} finally {
		removeSmokeRoot(smokeRoot);
	}
}

async function main() {
	const version = parseArgs(process.argv.slice(2));
	const result = await smokePublishedPigo(version);
	console.log(`Verified public install ${result.name}@${result.version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
