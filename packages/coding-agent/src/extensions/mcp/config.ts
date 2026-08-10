import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";
import { getPluginMcpConfiguration, getSessionMcpConfiguration } from "./session-config.ts";
import type { McpConfiguration, McpOAuthConfig, McpServerConfig } from "./types.ts";
import { isRecord } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_OAUTH_CALLBACK_PORT = 33_418;
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,48}$/;

interface ParsedConfigFile {
	servers: Map<string, McpServerConfig>;
	disabled: Set<string>;
	errors: string[];
}

function stringArray(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${field} 必须是字符串数组。`);
	}
	return value;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
	if (value === undefined) return {};
	if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) {
		throw new Error(`${field} 必须是字符串键值表。`);
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item as string]));
}

function parseTimeout(value: unknown): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(value) || (value as number) < 1_000 || (value as number) > 120_000) {
		throw new Error("timeoutMs 必须在 1000 到 120000 之间。");
	}
	return value as number;
}

function parseOAuth(value: unknown): McpOAuthConfig | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === true) return { callbackPort: DEFAULT_OAUTH_CALLBACK_PORT };
	if (!isRecord(value)) throw new Error("oauth 必须是 true、false 或配置对象。");
	for (const forbidden of ["accessToken", "refreshToken", "clientSecret", "token"]) {
		if (forbidden in value) throw new Error(`oauth.${forbidden} 不能写入 MCP 配置，请使用授权流程。`);
	}
	const clientId = value.clientId;
	const scope = value.scope;
	const callbackPort = value.callbackPort ?? DEFAULT_OAUTH_CALLBACK_PORT;
	if (clientId !== undefined && (typeof clientId !== "string" || !clientId.trim() || clientId.length > 1_024)) {
		throw new Error("oauth.clientId 必须是非空字符串。");
	}
	if (scope !== undefined && (typeof scope !== "string" || !scope.trim() || scope.length > 2_048)) {
		throw new Error("oauth.scope 必须是非空字符串。");
	}
	if (!Number.isInteger(callbackPort) || (callbackPort as number) < 1_024 || (callbackPort as number) > 65_535) {
		throw new Error("oauth.callbackPort 必须在 1024 到 65535 之间。");
	}
	return {
		callbackPort: callbackPort as number,
		...(typeof clientId === "string" ? { clientId: clientId.trim() } : {}),
		...(typeof scope === "string" ? { scope: scope.trim() } : {}),
	};
}

function parseServer(value: unknown, configDir: string): McpServerConfig {
	if (!isRecord(value)) throw new Error("服务器配置必须是对象。");
	if (typeof value.command === "string") {
		const configuredCwd = typeof value.cwd === "string" ? value.cwd : undefined;
		return {
			type: "stdio",
			command: value.command,
			args: stringArray(value.args, "args"),
			...(configuredCwd === undefined
				? {}
				: { cwd: isAbsolute(configuredCwd) ? configuredCwd : resolve(configDir, configuredCwd) }),
			env: stringRecord(value.env, "env"),
			timeoutMs: parseTimeout(value.timeoutMs),
		};
	}
	if (typeof value.url === "string") {
		const url = new URL(value.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url 只支持 http 或 https。");
		if (url.username || url.password) throw new Error("url 不能包含用户名或密码，请改用 headers。");
		const headers = stringRecord(value.headers, "headers");
		const oauth = parseOAuth(value.oauth);
		if (oauth && Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
			throw new Error("启用 oauth 时不能同时配置 Authorization header。");
		}
		return {
			type: value.transport === "sse" ? "sse" : "http",
			url: url.href,
			headers,
			timeoutMs: parseTimeout(value.timeoutMs),
			...(oauth === undefined ? {} : { oauth }),
		};
	}
	throw new Error("必须配置 command（stdio）或 url（HTTP）。");
}

function parseFile(path: string): ParsedConfigFile {
	const result: ParsedConfigFile = { servers: new Map(), disabled: new Set(), errors: [] };
	if (!existsSync(path)) return result;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) throw new Error("根节点必须是对象。");
		const rawServers = isRecord(parsed.mcpServers)
			? parsed.mcpServers
			: isRecord(parsed.servers)
				? parsed.servers
				: {};
		for (const [name, value] of Object.entries(rawServers)) {
			if (!SERVER_NAME.test(name)) {
				result.errors.push(`${path}: 服务器名 ${name} 无效，只能使用小写字母、数字、_ 和 -。`);
				continue;
			}
			try {
				result.servers.set(name, parseServer(value, dirname(path)));
			} catch (error) {
				result.errors.push(`${path}: ${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const name of stringArray(parsed.disabledServers, "disabledServers")) result.disabled.add(name);
	} catch (error) {
		result.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return result;
}

export function loadMcpConfiguration(cwd: string, projectTrusted: boolean): McpConfiguration {
	const user = parseFile(join(getAgentDir(), "mcp.json"));
	const project = projectTrusted ? parseFile(join(cwd, ".pi", "mcp.json")) : undefined;
	const servers = new Map(user.servers);
	if (project) for (const [name, config] of project.servers) servers.set(name, config);
	const disabled = new Set([...user.disabled, ...(project?.disabled ?? [])]);
	for (const name of disabled) servers.delete(name);
	for (const [name, config] of getPluginMcpConfiguration(cwd)) servers.set(name, config);
	for (const [name, config] of getSessionMcpConfiguration(cwd)) servers.set(name, config);
	return { servers, errors: [...user.errors, ...(project?.errors ?? [])] };
}

export function loadMcpConfigurationFiles(paths: readonly string[]): McpConfiguration {
	const servers = new Map<string, McpServerConfig>();
	const disabled = new Set<string>();
	const errors: string[] = [];
	for (const path of paths) {
		const parsed = parseFile(path);
		for (const [name, config] of parsed.servers) servers.set(name, config);
		for (const name of parsed.disabled) disabled.add(name);
		errors.push(...parsed.errors);
	}
	for (const name of disabled) servers.delete(name);
	return { servers, errors };
}

export function fingerprintMcpServer(config: McpServerConfig): string {
	const publicConfig =
		config.type === "stdio"
			? {
					type: config.type,
					command: config.command,
					args: config.args,
					cwd: config.cwd,
					envNames: Object.keys(config.env).sort(),
				}
			: {
					type: config.type,
					url: config.url,
					headerNames: Object.keys(config.headers).sort(),
					oauth: config.oauth,
				};
	return createHash("sha256").update(JSON.stringify(publicConfig)).digest("hex").slice(0, 24);
}
