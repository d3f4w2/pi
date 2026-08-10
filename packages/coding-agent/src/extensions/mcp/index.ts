import { type TSchema, Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { registerInternalReadResourceResolver } from "../../core/tools/unified-read.ts";
import { loadMcpConfiguration } from "./config.ts";
import type { McpManager } from "./manager.ts";
import type { McpConfiguration, McpToolDescriptor } from "./types.ts";

function proxyName(server: string, tool: string): string {
	const normalized = tool
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `mcp__${server}__${normalized || "tool"}`;
}

function asParameters(schema: Record<string, unknown>): TSchema {
	return Type.Unsafe<Record<string, unknown>>({
		...schema,
		type: schema.type ?? "object",
		additionalProperties: schema.additionalProperties ?? true,
	} as TSchema);
}

function resourceUri(server: string, uri: string): string {
	return `mcp://${server}/${Buffer.from(uri, "utf8").toString("base64url")}`;
}

function formatServers(manager: McpManager): string {
	const rows = manager.list();
	if (rows.length === 0) return "没有配置 MCP 服务器。请编辑 ~/.pi/agent/mcp.json 或项目 .pi/mcp.json。";
	return rows
		.map((server) => {
			const counts = `${server.toolCount} 工具 · ${server.resourceCount} 资源 · ${server.promptCount} 提示词`;
			return `${server.name} · ${server.state} · ${server.transport} · ${counts}${server.error ? `\n  ${server.error}` : ""}`;
		})
		.join("\n");
}

async function handleCommand(manager: McpManager, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const operation = parts[0] ?? "status";
	const name = parts[1];
	if (operation === "status" || operation === "list") {
		ctx.ui.notify(formatServers(manager), "info");
		return;
	}
	if (operation === "reload" || operation === "test") {
		const targets = name ? [name] : manager.list().map((server) => server.name);
		if (targets.length === 0) {
			ctx.ui.notify("没有配置 MCP 服务器。", "warning");
			return;
		}
		ctx.ui.notify(`正在连接 ${targets.length} 个 MCP 服务器…`, "info");
		const results = await Promise.allSettled(targets.map((target) => manager.refresh(target)));
		const failures = results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : []));
		ctx.ui.notify(
			failures.length === 0
				? `MCP 已刷新：${targets.join("、")}`
				: `MCP 刷新完成，${failures.length} 个失败：\n${failures.join("\n")}`,
			failures.length === 0 ? "info" : "warning",
		);
		return;
	}
	if (operation === "auth" && name) {
		ctx.ui.notify(`等待 ${name} 的 OAuth 授权。授权地址将在下一条通知中显示。`, "info");
		const snapshot = await manager.authorize(
			name,
			(url) => ctx.ui.notify(`请在浏览器中打开并完成授权：\n${url.toString()}`, "info"),
			ctx.signal,
		);
		ctx.ui.notify(`${name} 已授权并连接，发现 ${snapshot.toolCount} 个工具。`, "info");
		return;
	}
	if (operation === "resources") {
		const resources = manager.getResources(name);
		ctx.ui.notify(
			resources.length === 0
				? "没有发现 MCP 资源。"
				: resources
						.map(
							(resource) =>
								`${resource.server}/${resource.name}\n  ${resourceUri(resource.server, resource.uri)}`,
						)
						.join("\n"),
			"info",
		);
		return;
	}
	if (operation === "prompts") {
		const prompts = manager.getPrompts(name);
		ctx.ui.notify(
			prompts.length === 0
				? "没有发现 MCP 提示词。"
				: prompts
						.map(
							(prompt) =>
								`${prompt.server}/${prompt.name}${prompt.description ? ` · ${prompt.description}` : ""}`,
						)
						.join("\n"),
			"info",
		);
		return;
	}
	if (operation === "prompt" && name && parts[2]) {
		ctx.ui.notify(await manager.getPrompt(name, parts[2]), "info");
		return;
	}
	ctx.ui.notify(
		"用法：/mcp status | reload [服务器] | test [服务器] | auth <服务器> | resources [服务器] | prompts [服务器] | prompt <服务器> <名称>",
		"warning",
	);
}

export default function mcpExtension(pi: ExtensionAPI): void {
	const registered = new Set<string>();
	let configuration: McpConfiguration | undefined;
	let manager: McpManager | undefined;
	let managerPromise: Promise<McpManager> | undefined;
	let disposeResolver: (() => void) | undefined;

	const getManager = async (): Promise<McpManager> => {
		if (manager) return manager;
		if (!configuration) throw new Error("MCP session has not started.");
		managerPromise ??= (async () => {
			const { McpManager: Manager } = await import("./manager.ts");
			const managerRef: { current?: McpManager } = {};
			const created = new Manager({
				onTools(server, tools) {
					const current = managerRef.current;
					if (!current) return;
					for (const tool of tools) registerProxy(pi, current, server, tool, registered);
				},
			});
			managerRef.current = created;
			await created.initialize(configuration);
			manager = created;
			created.startDiscovery();
			return created;
		})().catch((error: unknown) => {
			managerPromise = undefined;
			throw error;
		});
		return managerPromise;
	};

	pi.on("session_start", async (_event, ctx) => {
		configuration = loadMcpConfiguration(ctx.cwd, ctx.isProjectTrusted());
		if (configuration.servers.size === 0) {
			if (configuration.errors.length > 0 && ctx.hasUI) ctx.ui.notify(configuration.errors.join("\n"), "warning");
			return;
		}
		const activeManager = await getManager();
		disposeResolver = registerInternalReadResourceResolver({
			name: "mcp",
			canRead: (uri) => uri.startsWith("mcp://"),
			read: async (uri, context) => {
				const parsed = new URL(uri);
				const encoded = parsed.pathname.replace(/^\/+/, "");
				if (!encoded) throw new Error("MCP 资源地址缺少资源 URI。");
				return activeManager.readResource(
					parsed.hostname,
					Buffer.from(encoded, "base64url").toString("utf8"),
					context.signal,
				);
			},
		});
		if (configuration.errors.length > 0 && ctx.hasUI) ctx.ui.notify(configuration.errors.join("\n"), "warning");
	});

	pi.on("session_shutdown", async () => {
		disposeResolver?.();
		disposeResolver = undefined;
		const activeManager = manager;
		manager = undefined;
		managerPromise = undefined;
		configuration = undefined;
		await activeManager?.close();
	});

	pi.registerCommand("mcp", {
		description: "查看、测试或刷新 MCP 服务器",
		handler: async (args, ctx) => handleCommand(await getManager(), args, ctx),
	});
}

function registerProxy(
	pi: ExtensionAPI,
	manager: McpManager,
	server: string,
	tool: McpToolDescriptor,
	registered: Set<string>,
): void {
	const name = proxyName(server, tool.name);
	if (registered.has(name)) return;
	registered.add(name);
	pi.registerTool({
		name,
		label: `${server} · ${tool.name}`,
		description: tool.description ?? `调用 ${server} 提供的 ${tool.name} 工具。`,
		promptSnippet: tool.description ?? `调用 MCP 服务器 ${server} 的 ${tool.name}`,
		discovery: { keywords: [server, tool.name, ...(tool.description ? [tool.description] : [])] },
		parameters: asParameters(tool.inputSchema),
		executionMode: tool.readOnly ? "parallel" : "sequential",
		approval: tool.readOnly
			? { tier: "read", reason: `读取 MCP 服务器 ${server}` }
			: { tier: "exec", reason: `执行 MCP 工具 ${server}/${tool.name}` },
		async execute(_toolCallId, params, signal) {
			const toolArgs = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
			return {
				content: await manager.callTool(server, tool.name, toolArgs, signal),
				details: { server, tool: tool.name },
			};
		},
	});
}
