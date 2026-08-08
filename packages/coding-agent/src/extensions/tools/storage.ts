import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";

export interface ToolPreferences {
	enabledTools: string[];
	disabledTools: string[];
}

export interface ToolPreferenceChange {
	toolName: string;
	active: boolean;
}

export interface ToolPreferencesStore {
	load(): Promise<ToolPreferences>;
	recordChanges(changes: readonly ToolPreferenceChange[]): Promise<void>;
}

function readToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)),
	].sort();
}

function parsePreferences(content: string | undefined): ToolPreferences {
	if (!content?.trim()) return { enabledTools: [], disabledTools: [] };
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { enabledTools: [], disabledTools: [] };
		}
		const record = parsed as Record<string, unknown>;
		const enabledTools = readToolNames(record.enabledTools);
		const enabled = new Set(enabledTools);
		return {
			enabledTools,
			disabledTools: readToolNames(record.disabledTools).filter((name) => !enabled.has(name)),
		};
	} catch {
		return { enabledTools: [], disabledTools: [] };
	}
}

export function applyToolPreferences(
	currentActiveTools: readonly string[],
	availableTools: readonly string[],
	preferences: ToolPreferences,
): string[] {
	const available = new Set(availableTools);
	const active = new Set(currentActiveTools.filter((name) => available.has(name)));
	for (const name of preferences.disabledTools) active.delete(name);
	for (const name of preferences.enabledTools) {
		if (available.has(name)) active.add(name);
	}
	return [...active];
}

export class ToolPreferencesStorage implements ToolPreferencesStore {
	private readonly storage: AuthStorageBackend;

	constructor(storage: AuthStorageBackend = new FileAuthStorageBackend(join(getAgentDir(), "tool-preferences.json"))) {
		this.storage = storage;
	}

	async load(): Promise<ToolPreferences> {
		return this.storage.withLockAsync(async (content) => ({ result: parsePreferences(content) }));
	}

	async recordChanges(changes: readonly ToolPreferenceChange[]): Promise<void> {
		if (changes.length === 0) return;
		await this.storage.withLockAsync(async (content) => {
			const current = parsePreferences(content);
			const enabled = new Set(current.enabledTools);
			const disabled = new Set(current.disabledTools);
			for (const change of changes) {
				if (change.active) {
					enabled.add(change.toolName);
					disabled.delete(change.toolName);
				} else {
					disabled.add(change.toolName);
					enabled.delete(change.toolName);
				}
			}
			const next: ToolPreferences = {
				enabledTools: [...enabled].sort(),
				disabledTools: [...disabled].sort(),
			};
			return { result: undefined, next: `${JSON.stringify(next, null, 2)}\n` };
		});
	}
}
