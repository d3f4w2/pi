import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
export type PluginScope = "user" | "project";

interface StoredBackup {
	pluginId: string;
	source: string;
	scope: PluginScope;
	currentPath: string;
	backupPath: string;
	fingerprint: string;
	createdAt: string;
}

interface BackupState {
	version: 1;
	backups: Record<string, StoredBackup>;
}

export interface PendingPluginUpdate extends StoredBackup {}

function emptyState(): BackupState {
	return { version: 1, backups: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readState(path: string): BackupState {
	if (!existsSync(path)) return emptyState();
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.backups)) return emptyState();
		const backups: Record<string, StoredBackup> = {};
		for (const [id, value] of Object.entries(parsed.backups)) {
			if (
				!isRecord(value) ||
				typeof value.pluginId !== "string" ||
				typeof value.source !== "string" ||
				(value.scope !== "user" && value.scope !== "project") ||
				typeof value.currentPath !== "string" ||
				typeof value.backupPath !== "string" ||
				typeof value.fingerprint !== "string" ||
				typeof value.createdAt !== "string"
			) {
				continue;
			}
			backups[id] = {
				pluginId: value.pluginId,
				source: value.source,
				scope: value.scope,
				currentPath: value.currentPath,
				backupPath: value.backupPath,
				fingerprint: value.fingerprint,
				createdAt: value.createdAt,
			};
		}
		return { version: 1, backups };
	} catch {
		return emptyState();
	}
}

function writeState(path: string, state: BackupState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporaryPath, path);
}

function backupRoot(installedPath: string): string {
	const parent = dirname(installedPath);
	if (basename(parent) === "node_modules") return join(dirname(parent), ".pi-plugin-backups");
	if (basename(dirname(parent)) === "node_modules") return join(dirname(dirname(parent)), ".pi-plugin-backups");
	return join(parent, ".pi-plugin-backups");
}

function isInside(root: string, candidate: string): boolean {
	const path = relative(resolve(root), resolve(candidate));
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function removeManagedBackup(path: string): void {
	const root = dirname(path);
	if (basename(root) !== ".pi-plugin-backups" || !isInside(root, path)) {
		throw new Error(`拒绝删除不受管理的插件备份：${path}`);
	}
	rmSync(path, { recursive: true, force: true });
}

export function beginPluginUpdate(options: {
	pluginId: string;
	source: string;
	scope: PluginScope;
	installedPath: string;
	fingerprint: string;
}): PendingPluginUpdate {
	if (!options.source.startsWith("npm:") && !options.source.startsWith("git:")) {
		throw new Error("本地插件由用户直接维护，不能通过 /plugins update 覆盖");
	}
	if (!existsSync(options.installedPath)) throw new Error(`插件目录不存在：${options.installedPath}`);
	const root = backupRoot(options.installedPath);
	mkdirSync(root, { recursive: true });
	const backupPath = join(root, `${options.pluginId}-${randomUUID()}`);
	renameSync(options.installedPath, backupPath);
	return {
		pluginId: options.pluginId,
		source: options.source,
		scope: options.scope,
		currentPath: options.installedPath,
		backupPath,
		fingerprint: options.fingerprint,
		createdAt: new Date().toISOString(),
	};
}

export function restorePluginUpdate(update: PendingPluginUpdate): void {
	if (existsSync(update.currentPath)) rmSync(update.currentPath, { recursive: true, force: true });
	if (!existsSync(update.backupPath)) throw new Error("插件更新失败，旧版本备份不存在");
	mkdirSync(dirname(update.currentPath), { recursive: true });
	renameSync(update.backupPath, update.currentPath);
}

export function commitPluginUpdate(statePath: string, update: PendingPluginUpdate): void {
	const state = readState(statePath);
	const previous = state.backups[update.pluginId];
	if (previous?.backupPath && previous.backupPath !== update.backupPath && existsSync(previous.backupPath)) {
		removeManagedBackup(previous.backupPath);
	}
	state.backups[update.pluginId] = update;
	writeState(statePath, state);
}

export function hasPluginBackup(statePath: string, pluginId: string): boolean {
	const backup = readState(statePath).backups[pluginId];
	return backup !== undefined && existsSync(backup.backupPath);
}

export function rollbackPluginUpdate(statePath: string, pluginId: string, currentFingerprint: string): StoredBackup {
	const state = readState(statePath);
	const backup = state.backups[pluginId];
	if (!backup || !existsSync(backup.backupPath)) throw new Error(`插件 ${pluginId} 没有可回滚版本`);
	if (!existsSync(backup.currentPath)) throw new Error(`当前插件目录不存在：${backup.currentPath}`);
	const replacementBackup = join(dirname(backup.backupPath), `${pluginId}-${randomUUID()}`);
	renameSync(backup.currentPath, replacementBackup);
	try {
		renameSync(backup.backupPath, backup.currentPath);
	} catch (error) {
		renameSync(replacementBackup, backup.currentPath);
		throw error;
	}
	const next: StoredBackup = {
		...backup,
		backupPath: replacementBackup,
		fingerprint: currentFingerprint,
		createdAt: new Date().toISOString(),
	};
	state.backups[pluginId] = next;
	writeState(statePath, state);
	return next;
}

export function removePluginBackup(statePath: string, pluginId: string): void {
	const state = readState(statePath);
	const backup = state.backups[pluginId];
	if (!backup) return;
	if (existsSync(backup.backupPath)) removeManagedBackup(backup.backupPath);
	delete state.backups[pluginId];
	writeState(statePath, state);
}
