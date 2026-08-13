#!/usr/bin/env node

import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PIGO_PACKAGE_NAME = "pi-gogogo";
export const PIGO_BIN_PATH = "dist/bundle/cli.js";
export const PIGO_UPDATE_URL = `https://registry.npmjs.org/${PIGO_PACKAGE_NAME}/latest`;

const PRODUCT_REPOSITORY_URL = "git+https://github.com/d3f4w2/pi-Gogogo.git";
const PRODUCT_HOMEPAGE = "https://github.com/d3f4w2/pi-Gogogo#readme";
const INTERNAL_PACKAGE_PREFIX = "@earendil-works/pi-";
const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"];
const PRODUCT_FILES = ["dist", "docs", "CHANGELOG.md", "LICENSE", "README.md"];
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const codingAgentDirectory = join(repoRoot, "packages", "coding-agent");
const defaultOutputDirectory = join(repoRoot, ".artifacts", "pi-gogogo", "package");
const pigoReleaseWorkflowPath = join(repoRoot, ".github", "workflows", "publish-pigo.yml");

function sortedObject(value) {
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function externalDependencies(dependencies = {}) {
	return sortedObject(
		Object.fromEntries(Object.entries(dependencies).filter(([name]) => !name.startsWith(INTERNAL_PACKAGE_PREFIX))),
	);
}

export function createPigoPackageManifest(sourceManifest) {
	const dependencies = externalDependencies(sourceManifest.dependencies);
	const optionalDependencies = externalDependencies(sourceManifest.optionalDependencies);
	return {
		name: PIGO_PACKAGE_NAME,
		version: sourceManifest.version,
		description: "Fast, governed coding agent CLI for real repositories",
		type: "module",
		piConfig: {
			name: "pigo",
			envPrefix: sourceManifest.piConfig?.envPrefix ?? "PI",
			configDir: sourceManifest.piConfig?.configDir ?? ".pi",
			updateUrl: PIGO_UPDATE_URL,
		},
		bin: {
			pigo: PIGO_BIN_PATH,
		},
		files: PRODUCT_FILES,
		...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
		...(Object.keys(optionalDependencies).length > 0 ? { optionalDependencies } : {}),
		...(sourceManifest.overrides ? { overrides: sourceManifest.overrides } : {}),
		engines: sourceManifest.engines,
		keywords: ["pigo", "coding-agent", "ai", "llm", "cli", "tui", "agent"],
		license: sourceManifest.license ?? "MIT",
		repository: {
			type: "git",
			url: PRODUCT_REPOSITORY_URL,
		},
		homepage: PRODUCT_HOMEPAGE,
		bugs: {
			url: "https://github.com/d3f4w2/pi-Gogogo/issues",
		},
		publishConfig: {
			access: "public",
		},
	};
}

function validateExactDependencies(field, dependencies, errors) {
	for (const [name, version] of Object.entries(dependencies ?? {})) {
		if (name.startsWith(INTERNAL_PACKAGE_PREFIX)) {
			errors.push(`${field} must not contain upstream workspace package ${name}`);
		}
		if (typeof version !== "string" || !EXACT_VERSION_PATTERN.test(version)) {
			errors.push(`${field}.${name} must use an exact version, received ${String(version)}`);
		}
	}
}

export function validatePigoPackageManifest(manifest) {
	const errors = [];
	if (manifest.name !== PIGO_PACKAGE_NAME) {
		errors.push(`package name must be ${PIGO_PACKAGE_NAME}`);
	}
	if (typeof manifest.version !== "string" || !EXACT_VERSION_PATTERN.test(manifest.version)) {
		errors.push("package version must be an exact semantic version");
	}
	if (manifest.type !== "module") {
		errors.push('package type must be "module"');
	}
	if (manifest.piConfig?.name !== "pigo") {
		errors.push("piConfig.name must be pigo");
	}
	if (manifest.piConfig?.envPrefix !== "PI" || manifest.piConfig?.configDir !== ".pi") {
		errors.push("piConfig must preserve PI environment variables and the .pi data directory");
	}
	if (manifest.piConfig?.updateUrl !== PIGO_UPDATE_URL) {
		errors.push(`piConfig.updateUrl must be ${PIGO_UPDATE_URL}`);
	}
	if (manifest.bin?.pigo !== PIGO_BIN_PATH) {
		errors.push(`bin.pigo must point to ${PIGO_BIN_PATH}`);
	}
	if (manifest.bin && Object.hasOwn(manifest.bin, "pi")) {
		errors.push("legacy bin.pi must not be published by the Pigo product package");
	}
	if (Object.keys(manifest.bin ?? {}).some((name) => name !== "pigo")) {
		errors.push("pigo must be the only published command");
	}
	for (const lifecycle of INSTALL_LIFECYCLE_SCRIPTS) {
		if (manifest.scripts?.[lifecycle]) {
			errors.push(`${lifecycle} lifecycle scripts are not allowed`);
		}
	}
	if (manifest.main !== undefined || manifest.exports !== undefined || manifest.types !== undefined) {
		errors.push("the Pigo product package must remain CLI-only");
	}
	if (manifest.repository?.url !== PRODUCT_REPOSITORY_URL || manifest.homepage !== PRODUCT_HOMEPAGE) {
		errors.push("package metadata must point at d3f4w2/pi-Gogogo");
	}
	if (manifest.publishConfig?.access !== "public" || manifest.private === true) {
		errors.push("the Pigo product package must be public");
	}
	for (const requiredFile of PRODUCT_FILES) {
		if (!manifest.files?.includes(requiredFile)) {
			errors.push(`package files must include ${requiredFile}`);
		}
	}
	validateExactDependencies("dependencies", manifest.dependencies, errors);
	validateExactDependencies("optionalDependencies", manifest.optionalDependencies, errors);
	return errors;
}

function normalizePackagePath(path) {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function validatePigoPackageFiles(files) {
	const normalized = new Set(files.map(normalizePackagePath));
	const errors = [];
	for (const required of [
		"package.json",
		"README.md",
		"LICENSE",
		"CHANGELOG.md",
		"docs/index.md",
		PIGO_BIN_PATH,
		"dist/bundle/image-resize-worker.js",
		"dist/bundle/run-verify-worker.js",
	]) {
		if (!normalized.has(required)) {
			errors.push(`product package is missing ${required}`);
		}
	}
	for (const [label, prefix] of [
		["built-in theme", "dist/modes/interactive/theme/"],
		["interactive asset", "dist/modes/interactive/assets/"],
		["HTML export template", "dist/core/export-html/"],
		["Windows sandbox helper", "dist/core/sandbox/windows/"],
	]) {
		if (![...normalized].some((path) => path.startsWith(prefix) && path.length > prefix.length)) {
			errors.push(`product package is missing a ${label} under ${prefix}`);
		}
	}
	return errors;
}

function isInsidePath(child, parent) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function assertSafePigoPackageOutput(outputDirectory, repositoryRoot = repoRoot) {
	const output = resolve(outputDirectory);
	const repository = resolve(repositoryRoot);
	const artifactPackage = join(repository, ".artifacts", "pi-gogogo", "package");
	const temporaryRoot = resolve(tmpdir());
	const isRepositoryArtifact = output === artifactPackage;
	const isTemporaryPackage = basename(output) === "package" && output !== temporaryRoot && isInsidePath(output, temporaryRoot);
	if (!isRepositoryArtifact && !isTemporaryPackage) {
		throw new Error(`Refusing unsafe Pigo package output directory: ${output}`);
	}
	return output;
}

function collectFiles(directory, root = directory) {
	const files = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			files.push(...collectFiles(path, root));
		} else {
			files.push(relative(root, path));
		}
	}
	return files;
}

function copyBundleJavaScript(sourceDirectory, outputDirectory) {
	mkdirSync(outputDirectory, { recursive: true });
	for (const entry of readdirSync(sourceDirectory)) {
		if (entry.endsWith(".js")) {
			cpSync(join(sourceDirectory, entry), join(outputDirectory, entry));
		}
	}
}

function copyMatchingFiles(sourceDirectory, outputDirectory, predicate) {
	mkdirSync(outputDirectory, { recursive: true });
	for (const entry of readdirSync(sourceDirectory)) {
		const sourcePath = join(sourceDirectory, entry);
		if (statSync(sourcePath).isFile() && predicate(entry)) {
			cpSync(sourcePath, join(outputDirectory, entry));
		}
	}
}

function copyRuntimeDistribution(sourceDirectory, outputDirectory) {
	copyBundleJavaScript(join(sourceDirectory, "bundle"), join(outputDirectory, "bundle"));
	copyMatchingFiles(
		join(sourceDirectory, "modes", "interactive", "theme"),
		join(outputDirectory, "modes", "interactive", "theme"),
		(entry) => entry.endsWith(".json"),
	);
	copyMatchingFiles(
		join(sourceDirectory, "modes", "interactive", "assets"),
		join(outputDirectory, "modes", "interactive", "assets"),
		(entry) => entry.endsWith(".png"),
	);
	copyMatchingFiles(
		join(sourceDirectory, "core", "export-html"),
		join(outputDirectory, "core", "export-html"),
		(entry) => entry.startsWith("template.") && [".css", ".html", ".js"].some((extension) => entry.endsWith(extension)),
	);
	cpSync(
		join(sourceDirectory, "core", "export-html", "vendor"),
		join(outputDirectory, "core", "export-html", "vendor"),
		{ recursive: true },
	);
	copyMatchingFiles(
		join(sourceDirectory, "core", "sandbox", "windows"),
		join(outputDirectory, "core", "sandbox", "windows"),
		(entry) => entry.endsWith(".ps1"),
	);
}

function productReadme(content) {
	return content
		.replaceAll("@earendil-works/pi-coding-agent", PIGO_PACKAGE_NAME)
		.replaceAll("packages/coding-agent/docs/", "docs/")
		.replaceAll(
			"(packages/coding-agent/README.md)",
			"(https://github.com/d3f4w2/pi-Gogogo/blob/main/packages/coding-agent/README.md)",
		);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function validateSourceContract(sourceManifest, readme) {
	const errors = validatePigoPackageManifest(createPigoPackageManifest(sourceManifest));
	if (sourceManifest.piConfig?.name !== "pigo" || sourceManifest.bin?.pigo !== PIGO_BIN_PATH) {
		errors.push("coding-agent source package must build the pigo command");
	}
	const installCommand = `npm install -g --ignore-scripts ${PIGO_PACKAGE_NAME}`;
	if (!readme.includes(installCommand)) {
		errors.push(`root README must contain: ${installCommand}`);
	}
	if (!readme.includes("pigo doctor")) {
		errors.push("root README must show pigo doctor as the post-install verification");
	}
	errors.push(...validatePigoReleaseWorkflow(readFileSync(pigoReleaseWorkflowPath, "utf8")));
	return errors;
}

export function validatePigoReleaseWorkflow(workflow) {
	const requirements = [
		["product repository guard", "github.repository == 'd3f4w2/pi-Gogogo'"],
		["OIDC permission", "id-token: write"],
		["first-publish bootstrap secret", "secrets.NPM_PUBLISH_TOKEN"],
		["Pigo-only publication", "node scripts/publish.mjs --pigo-only"],
		["public registry installation smoke", "node scripts/smoke-published-pigo.mjs --version"],
	];
	return requirements.flatMap(([label, evidence]) =>
		workflow.includes(evidence) ? [] : [`Pigo release workflow is missing ${label}: ${evidence}`],
	);
}

export function checkPigoPackageSource() {
	const sourceManifest = readJson(join(codingAgentDirectory, "package.json"));
	const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
	const errors = validateSourceContract(sourceManifest, readme);
	if (errors.length > 0) {
		throw new Error(`Pigo package contract failed:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
	return createPigoPackageManifest(sourceManifest);
}

export function buildPigoPackage(outputDirectory = defaultOutputDirectory) {
	const manifest = checkPigoPackageSource();
	const output = assertSafePigoPackageOutput(outputDirectory);
	const sourceDist = join(codingAgentDirectory, "dist");
	if (!existsSync(join(sourceDist, "bundle", "cli.js"))) {
		throw new Error("Built CLI is missing. Run npm run build:offline before building the Pigo product package.");
	}

	rmSync(output, { force: true, recursive: true });
	mkdirSync(output, { recursive: true });
	copyRuntimeDistribution(sourceDist, join(output, "dist"));
	cpSync(join(codingAgentDirectory, "docs"), join(output, "docs"), { recursive: true });
	cpSync(join(codingAgentDirectory, "CHANGELOG.md"), join(output, "CHANGELOG.md"));
	cpSync(join(repoRoot, "LICENSE"), join(output, "LICENSE"));
	writeFileSync(join(output, "README.md"), productReadme(readFileSync(join(repoRoot, "README.md"), "utf8")));
	writeFileSync(join(output, "package.json"), `${JSON.stringify(manifest, undefined, "\t")}\n`);
	writeFileSync(join(output, ".npmignore"), "# The package.json files field is the publication allowlist.\n");
	chmodSync(join(output, PIGO_BIN_PATH), 0o755);

	const fileErrors = validatePigoPackageFiles(collectFiles(output));
	if (fileErrors.length > 0) {
		throw new Error(`Pigo package files failed validation:\n${fileErrors.map((error) => `  - ${error}`).join("\n")}`);
	}
	return output;
}

function parseArgs(args) {
	let mode;
	let outputDirectory = defaultOutputDirectory;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--check" || arg === "--build") {
			if (mode) throw new Error("Choose exactly one of --check or --build");
			mode = arg;
			continue;
		}
		if (arg === "--out") {
			const value = args[++index];
			if (!value) throw new Error("--out requires a directory");
			outputDirectory = value;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!mode) throw new Error("Usage: node scripts/pigo-package.mjs <--check|--build> [--out <directory>]");
	if (mode === "--check" && outputDirectory !== defaultOutputDirectory) {
		throw new Error("--out can only be used with --build");
	}
	return { mode, outputDirectory };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.mode === "--check") {
		const manifest = checkPigoPackageSource();
		console.log(`${manifest.name}@${manifest.version} package contract is valid.`);
		return;
	}
	const output = buildPigoPackage(options.outputDirectory);
	console.log(`Built ${PIGO_PACKAGE_NAME} package at ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
