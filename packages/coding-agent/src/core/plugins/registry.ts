import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { VERSION } from "../../config.ts";
import { inspectPluginManifest } from "./manifest.ts";
import type { PluginCapabilityKind, RegisteredPlugin, ResolvedPluginCapabilities } from "./types.ts";

interface StoredPluginDecision {
	enabled: boolean;
	acceptedFingerprint?: string;
}

interface StoredPluginState {
	version: 1;
	plugins: Record<string, StoredPluginDecision>;
}

export interface PluginRegistryOptions {
	statePath: string;
	hostVersion?: string;
}

function emptyState(): StoredPluginState {
	return { version: 1, plugins: {} };
}

function readState(path: string): StoredPluginState {
	if (!existsSync(path)) return emptyState();
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1) {
			return emptyState();
		}
		if (!("plugins" in value) || typeof value.plugins !== "object" || value.plugins === null) return emptyState();
		const plugins: Record<string, StoredPluginDecision> = {};
		for (const [id, decision] of Object.entries(value.plugins)) {
			if (typeof decision !== "object" || decision === null || !("enabled" in decision)) continue;
			if (typeof decision.enabled !== "boolean") continue;
			const acceptedFingerprint =
				"acceptedFingerprint" in decision && typeof decision.acceptedFingerprint === "string"
					? decision.acceptedFingerprint
					: undefined;
			plugins[id] = { enabled: decision.enabled, ...(acceptedFingerprint ? { acceptedFingerprint } : {}) };
		}
		return { version: 1, plugins };
	} catch {
		return emptyState();
	}
}

export class PluginRegistry {
	readonly #statePath: string;
	readonly #hostVersion: string;
	readonly #entries = new Map<string, RegisteredPlugin>();
	#state: StoredPluginState;

	constructor(options: PluginRegistryOptions) {
		this.#statePath = resolve(options.statePath);
		this.#hostVersion = options.hostVersion ?? VERSION;
		this.#state = readState(this.#statePath);
	}

	register(pluginRoot: string, source: string): RegisteredPlugin {
		const inspection = inspectPluginManifest(pluginRoot, this.#hostVersion);
		const existing = this.#entries.get(inspection.manifest.id);
		if (existing && existing.root !== inspection.root) {
			throw new Error(
				`Plugin id collision: ${inspection.manifest.id} is provided by ${existing.source} and ${source}`,
			);
		}
		const decision = this.#state.plugins[inspection.manifest.id];
		const enabled = decision?.enabled === true && decision.acceptedFingerprint === inspection.fingerprint;
		const entry: RegisteredPlugin = {
			...inspection,
			source,
			enabled,
			requiresConfirmation: !enabled,
		};
		this.#entries.set(entry.manifest.id, entry);
		return entry;
	}

	get(id: string): RegisteredPlugin | undefined {
		return this.#entries.get(id);
	}

	list(): RegisteredPlugin[] {
		return Array.from(this.#entries.values()).sort((left, right) =>
			left.manifest.id.localeCompare(right.manifest.id),
		);
	}

	async setEnabled(id: string, enabled: boolean, confirm?: () => Promise<boolean>): Promise<boolean> {
		const entry = this.#entries.get(id);
		if (!entry) throw new Error(`Unknown controlled plugin: ${id}`);
		if (enabled && (!confirm || !(await confirm()))) return false;
		this.#state.plugins[id] = {
			enabled,
			...(enabled ? { acceptedFingerprint: entry.fingerprint } : {}),
		};
		entry.enabled = enabled;
		entry.requiresConfirmation = !enabled;
		this.#writeState();
		return true;
	}

	resolveEnabled(): ResolvedPluginCapabilities {
		const result: ResolvedPluginCapabilities = { extensions: [], skills: [], mcp: [], resources: [] };
		for (const entry of this.#entries.values()) {
			if (!entry.enabled) continue;
			for (const file of entry.files) {
				if (file.kind === "resources") {
					result.resources.push({
						pluginId: entry.manifest.id,
						relativePath: file.relativePath,
						absolutePath: file.absolutePath,
					});
					continue;
				}
				result[file.kind satisfies Exclude<PluginCapabilityKind, "resources">].push(file.absolutePath);
			}
		}
		return result;
	}

	#writeState(): void {
		mkdirSync(dirname(this.#statePath), { recursive: true });
		const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(this.#state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, this.#statePath);
	}
}
