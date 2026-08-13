#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildPigoPackage, PIGO_PACKAGE_NAME } from "./pigo-package.mjs";
import { resolveNpmCliPath } from "./npm-cli.mjs";
import { getPigoProductPackage, getPublicWorkspacePackages } from "./release-packages.mjs";

const workspacePackages = getPublicWorkspacePackages();

const dryRun = process.argv.includes("--dry-run");
const pigoOnly = process.argv.includes("--pigo-only");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run" && arg !== "--pigo-only");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run] [--pigo-only]`);
	process.exit(1);
}

const packages = pigoOnly
	? [{ ...getPigoProductPackage(), directory: buildPigoPackage() }]
	: workspacePackages;

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function spawnNpm(args, options) {
	const npmCliPath = resolveNpmCliPath();
	return npmCliPath
		? spawnSync(process.execPath, [npmCliPath, ...args], options)
		: spawnSync(commandForPlatform("npm"), args, options);
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const spawnOptions = {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	};
	const result = command === "npm" ? spawnNpm(args, spawnOptions) : spawnSync(commandForPlatform(command), args, spawnOptions);

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	const result = spawnNpm(["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const packageVersions = new Map(packages.map((pkg) => [pkg.name, pkg.version]));

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(`Publishing ${pigoOnly ? PIGO_PACKAGE_NAME : "pi workspace packages"} at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

const packageStates = packages.map((pkg) => ({
	...pkg,
	published: false,
	version: packageVersions.get(pkg.name),
}));

for (const pkg of packageStates) {
	assertBuildOutputExists(pkg.directory);
	pkg.published = isPublished(pkg.name, pkg.version);

	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} is already published; validating package contents only.`);
	} else {
		console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
	}
	validatePack(pkg.directory);
	console.log();
}

if (dryRun) {
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
		continue;
	}

	run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts"], { cwd: pkg.directory });
	console.log();
}
