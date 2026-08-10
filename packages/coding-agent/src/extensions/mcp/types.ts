import type { Tool } from "@modelcontextprotocol/client";

export interface McpStdioServerConfig {
	type: "stdio";
	command: string;
	args: string[];
	cwd?: string;
	env: Record<string, string>;
	timeoutMs: number;
}

export interface McpHttpServerConfig {
	type: "http" | "sse";
	url: string;
	headers: Record<string, string>;
	timeoutMs: number;
	oauth?: McpOAuthConfig;
}

export interface McpOAuthConfig {
	clientId?: string;
	scope?: string;
	callbackPort: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConfiguration {
	servers: ReadonlyMap<string, McpServerConfig>;
	errors: string[];
}

export interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
}

export interface McpServerSnapshot {
	name: string;
	state: "cached" | "connecting" | "connected" | "authorization_required" | "failed";
	transport: "stdio" | "http" | "sse";
	toolCount: number;
	resourceCount: number;
	promptCount: number;
	updatedAt?: string;
	error?: string;
}

export interface McpCachedServer {
	fingerprint: string;
	tools: McpToolDescriptor[];
	resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
	prompts: Array<{ name: string; description?: string }>;
	updatedAt: string;
}

export interface McpCacheFile {
	version: 1;
	servers: Record<string, McpCachedServer>;
}

export function toToolDescriptor(tool: Tool): McpToolDescriptor {
	return {
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
		readOnly: tool.annotations?.readOnlyHint === true,
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
