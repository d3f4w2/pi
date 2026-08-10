import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { satisfies, valid, validRange } from "semver";
import type {
	ControlledPluginManifest,
	InspectedPluginFile,
	PluginCapabilities,
	PluginCapabilityKind,
	PluginInspection,
} from "./types.ts";

const MANIFEST_NAME = "pi-plugin.json";
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^sha256-[A-Za-z0-9+/]{43}=$/;
const CAPABILITY_KINDS: PluginCapabilityKind[] = ["extensions", "skills", "mcp", "resources"];
const LIFECYCLE_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish"]);
const MAX_CAPABILITY_FILES = 256;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) throw new Error(`${field} contains unsupported fields: ${unexpected.join(", ")}`);
}

function stringArray(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new Error(`${field} must be an array of relative paths`);
	}
	return [...value];
}

function parseCapabilities(value: unknown): PluginCapabilities {
	if (!isRecord(value)) throw new Error("capabilities must be an object");
	assertOnlyKeys(value, CAPABILITY_KINDS, "capabilities");
	return {
		extensions: stringArray(value.extensions, "capabilities.extensions"),
		skills: stringArray(value.skills, "capabilities.skills"),
		mcp: stringArray(value.mcp, "capabilities.mcp"),
		resources: stringArray(value.resources, "capabilities.resources"),
	};
}

function parseIntegrity(value: unknown): Record<string, string> {
	if (!isRecord(value)) throw new Error("integrity must be an object");
	const result: Record<string, string> = {};
	for (const [path, integrity] of Object.entries(value)) {
		if (typeof integrity !== "string" || !SHA256.test(integrity)) {
			throw new Error(`integrity for ${path} must use sha256-<base64>`);
		}
		result[path] = integrity;
	}
	return result;
}

function parseManifest(value: unknown, hostVersion: string): ControlledPluginManifest {
	if (!isRecord(value)) throw new Error("plugin manifest must be an object");
	assertOnlyKeys(
		value,
		["schemaVersion", "id", "version", "minimumPiVersion", "capabilities", "integrity"],
		"plugin manifest",
	);
	if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
	if (typeof value.id !== "string" || !PLUGIN_ID.test(value.id)) {
		throw new Error("id must be a lowercase plugin identifier with at most 64 characters");
	}
	if (typeof value.version !== "string" || valid(value.version) === null) {
		throw new Error("version must be an exact semantic version");
	}
	const minimumPiVersion = value.minimumPiVersion;
	if (minimumPiVersion !== undefined) {
		if (typeof minimumPiVersion !== "string" || validRange(minimumPiVersion) === null) {
			throw new Error("minimumPiVersion must be a semantic version range");
		}
		if (!satisfies(hostVersion, minimumPiVersion)) {
			throw new Error(`Plugin ${value.id} requires pi ${minimumPiVersion}; current version is ${hostVersion}`);
		}
	}
	return {
		schemaVersion: 1,
		id: value.id,
		version: value.version,
		...(minimumPiVersion === undefined ? {} : { minimumPiVersion }),
		capabilities: parseCapabilities(value.capabilities),
		integrity: parseIntegrity(value.integrity),
	};
}

function normalizeRelativePath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	if (
		!normalized ||
		isAbsolute(path) ||
		/^[A-Za-z]:/.test(normalized) ||
		normalized.includes("\0") ||
		normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
		/[?*[\]{}]/.test(normalized)
	) {
		throw new Error(`Plugin capability must use an exact relative path: ${path}`);
	}
	return normalized;
}

function ensureNoSymlink(root: string, relativePath: string): void {
	let current = root;
	for (const part of relativePath.split("/")) {
		current = resolve(current, part);
		if (lstatSync(current).isSymbolicLink())
			throw new Error(`Plugin capability cannot use a symbolic link: ${relativePath}`);
	}
}

function verifyFile(
	root: string,
	kind: PluginCapabilityKind,
	path: string,
	expectedIntegrity: string | undefined,
): InspectedPluginFile {
	const relativePath = normalizeRelativePath(path);
	if (!expectedIntegrity) throw new Error(`Missing integrity entry for ${relativePath}`);
	const absolutePath = resolve(root, ...relativePath.split("/"));
	if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
		throw new Error(`Plugin capability resolves outside the plugin root: ${relativePath}`);
	}
	if (!existsSync(absolutePath)) throw new Error(`Declared plugin file does not exist: ${relativePath}`);
	ensureNoSymlink(root, relativePath);
	const realPath = realpathSync(absolutePath);
	if (realPath !== root && !realPath.startsWith(`${root}${sep}`)) {
		throw new Error(`Plugin capability resolves outside the plugin root: ${relativePath}`);
	}
	const stats = lstatSync(absolutePath);
	if (!stats.isFile()) throw new Error(`Declared plugin capability is not a file: ${relativePath}`);
	if (stats.size > MAX_FILE_BYTES)
		throw new Error(`Declared plugin file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
	const actualIntegrity = `sha256-${createHash("sha256").update(readFileSync(absolutePath)).digest("base64")}`;
	if (actualIntegrity !== expectedIntegrity) throw new Error(`Plugin integrity check failed: ${relativePath}`);
	return { kind, relativePath, absolutePath, bytes: stats.size, integrity: actualIntegrity };
}

function rejectLifecycleScripts(root: string): void {
	const packagePath = resolve(root, "package.json");
	if (!existsSync(packagePath)) return;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(packagePath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot parse package.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value) || !isRecord(value.scripts)) return;
	const lifecycle = Object.keys(value.scripts).filter((name) => LIFECYCLE_SCRIPTS.has(name));
	if (lifecycle.length > 0)
		throw new Error(`Controlled plugins cannot declare lifecycle scripts: ${lifecycle.join(", ")}`);
}

export function inspectPluginManifest(pluginRoot: string, hostVersion: string): PluginInspection {
	const root = realpathSync(resolve(pluginRoot));
	const manifestPath = resolve(root, MANIFEST_NAME);
	if (!existsSync(manifestPath)) throw new Error(`Missing ${MANIFEST_NAME}: ${root}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot parse ${MANIFEST_NAME}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const manifest = parseManifest(parsed, hostVersion);
	rejectLifecycleScripts(root);
	const seen = new Set<string>();
	const files: InspectedPluginFile[] = [];
	for (const kind of CAPABILITY_KINDS) {
		for (const rawPath of manifest.capabilities[kind]) {
			const relativePath = normalizeRelativePath(rawPath);
			if (seen.has(relativePath))
				throw new Error(`Plugin capability path is declared more than once: ${relativePath}`);
			seen.add(relativePath);
			files.push(verifyFile(root, kind, relativePath, manifest.integrity[relativePath]));
		}
	}
	if (files.length === 0) throw new Error("Controlled plugin must declare at least one capability file");
	if (files.length > MAX_CAPABILITY_FILES) throw new Error(`Controlled plugin exceeds ${MAX_CAPABILITY_FILES} files`);
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Controlled plugin exceeds ${MAX_TOTAL_BYTES} total bytes`);
	const extraIntegrity = Object.keys(manifest.integrity).filter((path) => !seen.has(normalizeRelativePath(path)));
	if (extraIntegrity.length > 0) throw new Error(`Integrity contains undeclared files: ${extraIntegrity.join(", ")}`);
	const fingerprint = `sha256-${createHash("sha256").update(JSON.stringify(manifest)).digest("base64")}`;
	return { root, manifestPath, manifest, fingerprint, files };
}

export function hasControlledPluginManifest(pluginRoot: string): boolean {
	return existsSync(resolve(pluginRoot, MANIFEST_NAME));
}
