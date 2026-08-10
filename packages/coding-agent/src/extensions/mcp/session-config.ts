import type { McpServerConfig } from "./types.ts";

const configurations = new Map<string, ReadonlyMap<string, McpServerConfig>>();
const pluginConfigurations = new Map<string, ReadonlyMap<string, McpServerConfig>>();

export function setSessionMcpConfiguration(cwd: string, servers: ReadonlyMap<string, McpServerConfig>): void {
	configurations.set(cwd, new Map(servers));
}

export function getSessionMcpConfiguration(cwd: string): ReadonlyMap<string, McpServerConfig> {
	return configurations.get(cwd) ?? new Map();
}

export function clearSessionMcpConfiguration(cwd: string): void {
	configurations.delete(cwd);
}

export function setPluginMcpConfiguration(cwd: string, servers: ReadonlyMap<string, McpServerConfig>): void {
	pluginConfigurations.set(cwd, new Map(servers));
}

export function getPluginMcpConfiguration(cwd: string): ReadonlyMap<string, McpServerConfig> {
	return pluginConfigurations.get(cwd) ?? new Map();
}

export function clearPluginMcpConfiguration(cwd: string): void {
	pluginConfigurations.delete(cwd);
}
