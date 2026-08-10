import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { type ConfiguredPackage, DefaultPackageManager, type PackageManager } from "../../core/package-manager.ts";
import { hasControlledPluginManifest, PluginRegistry } from "../../core/plugins/index.ts";
import type { RegisteredPlugin } from "../../core/plugins/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { registerInternalReadResourceResolver } from "../../core/tools/unified-read.ts";
import { loadMcpConfigurationFiles } from "../mcp/config.ts";
import { clearPluginMcpConfiguration, setPluginMcpConfiguration } from "../mcp/session-config.ts";
import type { PluginScope } from "./updates.ts";
import {
	beginPluginUpdate,
	commitPluginUpdate,
	hasPluginBackup,
	removePluginBackup,
	restorePluginUpdate,
	rollbackPluginUpdate,
} from "./updates.ts";

type PluginOperation =
	| "menu"
	| "list"
	| "add"
	| "inspect"
	| "enable"
	| "disable"
	| "update"
	| "rollback"
	| "remove"
	| "help";

interface PluginCommand {
	operation: PluginOperation;
	source?: string;
	scope: PluginScope;
}

export interface PluginEnvironment {
	manager: PackageManager;
	registry: PluginRegistry;
	language: "zh-CN" | "en";
	backupStatePath: string;
}

export interface PluginExtensionDependencies {
	createEnvironment?: (ctx: ExtensionContext) => PluginEnvironment;
}

function defaultEnvironment(ctx: ExtensionContext): PluginEnvironment {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
	const setting = settings.getLanguage();
	const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
	return {
		manager: new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: settings }),
		registry: new PluginRegistry({ statePath: join(agentDir, "plugin-state.json") }),
		language: setting === "zh-CN" || (setting === "auto" && locale.startsWith("zh")) ? "zh-CN" : "en",
		backupStatePath: join(agentDir, "plugin-backups.json"),
	};
}

function assertSafeSource(source: string): void {
	const candidate = source.startsWith("git:") ? source.slice(4) : source;
	if (!candidate.includes("://")) return;
	const url = new URL(candidate);
	if (url.username || url.password) throw new Error("插件地址不能包含用户名、密码或访问令牌");
}

export function parsePluginCommand(args: string): PluginCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const scope: PluginScope = parts.includes("--project") ? "project" : "user";
	const positional = parts.filter((part) => part !== "--project" && part !== "--user");
	const candidate = positional[0]?.toLowerCase();
	const supported: PluginOperation[] = [
		"list",
		"add",
		"inspect",
		"enable",
		"disable",
		"update",
		"rollback",
		"remove",
		"help",
	];
	const operation: PluginOperation = supported.includes(candidate as PluginOperation)
		? (candidate as PluginOperation)
		: positional.length === 0
			? "menu"
			: "help";
	return { operation, scope, ...(positional[1] ? { source: positional.slice(1).join(" ") } : {}) };
}

function discover(environment: PluginEnvironment): { plugins: RegisteredPlugin[]; errors: string[] } {
	const plugins: RegisteredPlugin[] = [];
	const errors: string[] = [];
	for (const configured of environment.manager.listConfiguredPackages()) {
		if (!configured.installedPath || !hasControlledPluginManifest(configured.installedPath)) continue;
		try {
			plugins.push(environment.registry.register(configured.installedPath, configured.source));
		} catch (error) {
			errors.push(`${configured.source}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { plugins, errors };
}

function capabilitySummary(plugin: RegisteredPlugin): string {
	const counts = { extensions: 0, skills: 0, mcp: 0, resources: 0 };
	for (const file of plugin.files) counts[file.kind] += 1;
	return `extensions ${counts.extensions} · skills ${counts.skills} · MCP ${counts.mcp} · resources ${counts.resources}`;
}

function formatPlugin(plugin: RegisteredPlugin, language: "zh-CN" | "en", backup = false): string {
	const state = plugin.enabled
		? language === "en"
			? "enabled"
			: "已启用"
		: language === "en"
			? "disabled"
			: "未启用";
	return [
		`${plugin.manifest.id} v${plugin.manifest.version} · ${state}${backup ? ` · ${language === "en" ? "rollback ready" : "可回滚"}` : ""}`,
		`${language === "en" ? "Source" : "来源"}：${plugin.source}`,
		`${language === "en" ? "Capabilities" : "能力"}：${capabilitySummary(plugin)}`,
		`${language === "en" ? "Fingerprint" : "指纹"}：${plugin.fingerprint.slice(0, 19)}`,
	].join("\n");
}

function help(language: "zh-CN" | "en"): string {
	return language === "en"
		? "Usage: /plugins list | add <source> [--project] | inspect/enable/disable/update/rollback/remove <source>"
		: "用法：/plugins list | add <来源> [--project] | inspect/enable/disable/update/rollback/remove <来源>";
}

function configuredTarget(manager: PackageManager, command: PluginCommand): ConfiguredPackage {
	if (!command.source) throw new Error("缺少插件来源");
	const matches = manager.listConfiguredPackages().filter((entry) => entry.source === command.source);
	const target =
		matches.find((entry) => entry.scope === command.scope) ?? (matches.length === 1 ? matches[0] : undefined);
	if (!target) throw new Error(`没有找到已配置插件：${command.source}`);
	return target;
}

function registeredTarget(environment: PluginEnvironment, command: PluginCommand): RegisteredPlugin {
	const target = configuredTarget(environment.manager, command);
	if (!target.installedPath) throw new Error(`插件尚未安装：${target.source}`);
	if (!hasControlledPluginManifest(target.installedPath))
		throw new Error(`${target.source} 不是受控插件，缺少 pi-plugin.json`);
	return environment.registry.register(target.installedPath, target.source);
}

async function chooseConfigured(
	environment: PluginEnvironment,
	ctx: ExtensionCommandContext,
): Promise<ConfiguredPackage | undefined> {
	const entries = environment.manager
		.listConfiguredPackages()
		.filter((entry) => entry.installedPath && hasControlledPluginManifest(entry.installedPath));
	const labels = entries.map((entry) => `${entry.source} · ${entry.scope}`);
	const selected = await ctx.ui.select(environment.language === "en" ? "Choose plugin" : "选择插件", labels);
	const index = selected ? labels.indexOf(selected) : -1;
	return index >= 0 ? entries[index] : undefined;
}

async function fillMenu(
	command: PluginCommand,
	environment: PluginEnvironment,
	ctx: ExtensionCommandContext,
): Promise<PluginCommand | undefined> {
	if (command.operation !== "menu") return command;
	const actions =
		environment.language === "en"
			? ["List", "Add", "Inspect", "Enable", "Disable", "Update", "Rollback", "Remove"]
			: ["查看", "添加", "检查", "启用", "停用", "更新", "回滚", "移除"];
	const operations = ["list", "add", "inspect", "enable", "disable", "update", "rollback", "remove"] as const;
	const selected = await ctx.ui.select(environment.language === "en" ? "Controlled plugins" : "受控插件", actions);
	if (!selected) return undefined;
	const operation = operations[actions.indexOf(selected)];
	if (!operation) return undefined;
	if (operation === "list") return { operation, scope: "user" };
	if (operation === "add") {
		const source = await ctx.ui.input(environment.language === "en" ? "Plugin source" : "插件来源", "npm:name@1.2.3");
		if (!source?.trim()) return undefined;
		const scopes = environment.language === "en" ? ["All projects", "Current project"] : ["所有项目", "当前项目"];
		const selectedScope = await ctx.ui.select(environment.language === "en" ? "Scope" : "范围", scopes);
		if (!selectedScope) return undefined;
		return {
			operation,
			source: source.trim(),
			scope: selectedScope === "Current project" || selectedScope === "当前项目" ? "project" : "user",
		};
	}
	const target = await chooseConfigured(environment, ctx);
	if (!target) return undefined;
	return { operation, source: target.source, scope: target.scope };
}

async function confirmEnable(
	environment: PluginEnvironment,
	plugin: RegisteredPlugin,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	ctx.ui.notify(formatPlugin(plugin, environment.language), "info");
	return environment.registry.setEnabled(plugin.manifest.id, true, () =>
		ctx.ui.confirm(
			environment.language === "en" ? "Enable this plugin?" : "启用这个插件？",
			environment.language === "en"
				? "Verified extension code runs with your user permissions. MCP servers keep normal tool approval rules."
				: "已校验的扩展代码拥有当前用户权限；MCP 服务仍遵守正常的工具审批规则。",
		),
	);
}

async function addPlugin(
	environment: PluginEnvironment,
	command: PluginCommand,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!command.source) throw new Error("缺少插件来源");
	if (command.scope === "project" && !ctx.isProjectTrusted()) throw new Error("当前项目未受信任，不能启用项目插件");
	assertSafeSource(command.source);
	const local = command.scope === "project";
	await environment.manager.install(command.source, { local });
	const path = environment.manager.getInstalledPath(command.source, command.scope);
	if (!path) throw new Error(`安装完成但找不到插件目录：${command.source}`);
	let plugin: RegisteredPlugin;
	try {
		plugin = environment.registry.register(path, command.source);
	} catch (error) {
		await environment.manager.remove(command.source, { local });
		throw error;
	}
	if (!(await confirmEnable(environment, plugin, ctx))) {
		await environment.manager.remove(command.source, { local });
		return;
	}
	environment.manager.addSourceToSettings(command.source, { local });
	try {
		await ctx.reload();
	} catch (error) {
		environment.manager.removeSourceFromSettings(command.source, { local });
		await environment.registry.setEnabled(plugin.manifest.id, false);
		throw error;
	}
}

async function updatePlugin(
	environment: PluginEnvironment,
	command: PluginCommand,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const target = configuredTarget(environment.manager, command);
	const current = registeredTarget(environment, command);
	if (
		!(await ctx.ui.confirm(
			environment.language === "en" ? "Download and verify an update?" : "下载并校验更新？",
			formatPlugin(current, environment.language, hasPluginBackup(environment.backupStatePath, current.manifest.id)),
		))
	) {
		return;
	}
	const pending = beginPluginUpdate({
		pluginId: current.manifest.id,
		source: target.source,
		scope: target.scope,
		installedPath: current.root,
		fingerprint: current.fingerprint,
	});
	let committed = false;
	try {
		await environment.manager.install(target.source, { local: target.scope === "project" });
		const updated = environment.registry.register(current.root, target.source);
		if (!(await confirmEnable(environment, updated, ctx))) {
			restorePluginUpdate(pending);
			return;
		}
		commitPluginUpdate(environment.backupStatePath, pending);
		committed = true;
		await ctx.reload();
	} catch (error) {
		restorePluginUpdate(pending);
		if (committed) {
			removePluginBackup(environment.backupStatePath, current.manifest.id);
			const restored = environment.registry.register(current.root, current.source);
			await environment.registry.setEnabled(restored.manifest.id, true, async () => true);
		}
		throw error;
	}
}

async function rollbackPlugin(
	environment: PluginEnvironment,
	command: PluginCommand,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const current = registeredTarget(environment, command);
	if (!hasPluginBackup(environment.backupStatePath, current.manifest.id)) {
		throw new Error(`插件 ${current.manifest.id} 没有可回滚版本`);
	}
	if (
		!(await ctx.ui.confirm(
			environment.language === "en" ? "Rollback plugin?" : "回滚插件？",
			formatPlugin(current, environment.language),
		))
	) {
		return;
	}
	rollbackPluginUpdate(environment.backupStatePath, current.manifest.id, current.fingerprint);
	const restored = environment.registry.register(current.root, current.source);
	await environment.registry.setEnabled(restored.manifest.id, true, async () => true);
	await ctx.reload();
}

function mimeType(path: string): string | undefined {
	switch (extname(path).toLowerCase()) {
		case ".md":
			return "text/markdown";
		case ".json":
			return "application/json";
		case ".txt":
			return "text/plain";
		case ".html":
			return "text/html";
		default:
			return undefined;
	}
}

export function pluginResourceUri(pluginId: string, relativePath: string): string {
	return `plugin://${pluginId}/${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

function installPluginResources(environment: PluginEnvironment, ctx: ExtensionContext): () => void {
	const discovered = discover(environment);
	const enabled = discovered.plugins.filter((plugin) => plugin.enabled);
	const mcpFiles = enabled.flatMap((plugin) =>
		plugin.files.filter((file) => file.kind === "mcp").map((file) => file.absolutePath),
	);
	const mcp = loadMcpConfigurationFiles(mcpFiles);
	setPluginMcpConfiguration(ctx.cwd, mcp.servers);
	const messages = [...discovered.errors, ...mcp.errors];
	if (messages.length > 0 && ctx.hasUI) ctx.ui.notify(messages.join("\n"), "warning");
	return registerInternalReadResourceResolver({
		name: "plugin",
		canRead: (uri) => uri.startsWith("plugin://"),
		read: async (uri) => {
			const parsed = new URL(uri);
			const plugin = environment.registry.get(parsed.hostname);
			if (!plugin?.enabled) throw new Error(`插件未启用：${parsed.hostname}`);
			const encoded = parsed.pathname.replace(/^\/+/, "");
			if (!encoded) throw new Error("插件资源地址缺少资源路径");
			const relativePath = Buffer.from(encoded, "base64url").toString("utf8");
			const file = plugin.files.find(
				(candidate) => candidate.kind === "resources" && candidate.relativePath === relativePath,
			);
			if (!file) throw new Error(`插件没有声明资源：${relativePath}`);
			return {
				data: readFileSync(file.absolutePath),
				...(mimeType(file.absolutePath) ? { mimeType: mimeType(file.absolutePath) } : {}),
				label: `${plugin.manifest.id}/${file.relativePath}`,
			};
		},
	});
}

async function runCommand(
	dependencies: PluginExtensionDependencies,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const environment = (dependencies.createEnvironment ?? defaultEnvironment)(ctx);
	environment.manager.setProgressCallback((event) =>
		ctx.ui.setStatus("plugins", event.type === "complete" ? undefined : (event.message ?? event.action)),
	);
	try {
		const command = await fillMenu(parsePluginCommand(args), environment, ctx);
		if (!command) return;
		if (command.operation === "help") return ctx.ui.notify(help(environment.language), "info");
		if (command.operation === "list") {
			const found = discover(environment);
			const rows = found.plugins.map((plugin) =>
				formatPlugin(
					plugin,
					environment.language,
					hasPluginBackup(environment.backupStatePath, plugin.manifest.id),
				),
			);
			ctx.ui.notify(
				[...rows, ...found.errors.map((error) => `Error: ${error}`)].join("\n\n") ||
					(environment.language === "en" ? "No controlled plugins." : "没有受控插件。"),
				found.errors.length ? "warning" : "info",
			);
			return;
		}
		if (command.operation === "add") return await addPlugin(environment, command, ctx);
		if (command.operation === "inspect") {
			const plugin = registeredTarget(environment, command);
			ctx.ui.notify(
				formatPlugin(
					plugin,
					environment.language,
					hasPluginBackup(environment.backupStatePath, plugin.manifest.id),
				),
				"info",
			);
			return;
		}
		if (command.operation === "enable") {
			if (await confirmEnable(environment, registeredTarget(environment, command), ctx)) await ctx.reload();
			return;
		}
		if (command.operation === "disable") {
			const plugin = registeredTarget(environment, command);
			if (
				await ctx.ui.confirm(environment.language === "en" ? "Disable plugin?" : "停用插件？", plugin.manifest.id)
			) {
				await environment.registry.setEnabled(plugin.manifest.id, false);
				await ctx.reload();
			}
			return;
		}
		if (command.operation === "update") return await updatePlugin(environment, command, ctx);
		if (command.operation === "rollback") return await rollbackPlugin(environment, command, ctx);
		if (command.operation === "remove") {
			const target = configuredTarget(environment.manager, command);
			const plugin = registeredTarget(environment, command);
			if (
				!(await ctx.ui.confirm(environment.language === "en" ? "Remove plugin?" : "移除插件？", plugin.manifest.id))
			)
				return;
			await environment.registry.setEnabled(plugin.manifest.id, false);
			await environment.manager.removeAndPersist(target.source, { local: target.scope === "project" });
			removePluginBackup(environment.backupStatePath, plugin.manifest.id);
			await ctx.reload();
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		environment.manager.setProgressCallback(undefined);
		ctx.ui.setStatus("plugins", undefined);
	}
}

export function createPluginsExtension(dependencies: PluginExtensionDependencies = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		let disposeResolver: (() => void) | undefined;
		pi.on("session_start", async (_event, ctx) => {
			disposeResolver?.();
			disposeResolver = installPluginResources((dependencies.createEnvironment ?? defaultEnvironment)(ctx), ctx);
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			disposeResolver?.();
			disposeResolver = undefined;
			clearPluginMcpConfiguration(ctx.cwd);
		});
		pi.registerCommand("plugins", {
			description: "安装、校验、启停、更新或回滚受控插件",
			handler: (args, ctx) => runCommand(dependencies, args, ctx),
		});
	};
}

export default createPluginsExtension();
