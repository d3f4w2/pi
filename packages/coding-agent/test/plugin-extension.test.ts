import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { loadMcpConfiguration, loadMcpConfigurationFiles } from "../src/extensions/mcp/config.ts";
import { clearPluginMcpConfiguration, setPluginMcpConfiguration } from "../src/extensions/mcp/session-config.ts";
import { pluginResourceUri } from "../src/extensions/plugins/index.ts";

const roots: string[] = [];
const previousAgentDir = process.env[ENV_AGENT_DIR];

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("controlled plugin integration", () => {
	it("merges verified plugin MCP configs between user and session scopes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-plugin-mcp-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ servers: { shared: { command: "user-server" } } }),
			"utf8",
		);
		const pluginConfigPath = join(root, "plugin-mcp.json");
		writeFileSync(
			pluginConfigPath,
			JSON.stringify({ servers: { shared: { command: "plugin-server" }, plugin: { command: "plugin-only" } } }),
			"utf8",
		);
		const pluginConfig = loadMcpConfigurationFiles([pluginConfigPath]);
		setPluginMcpConfiguration(cwd, pluginConfig.servers);
		try {
			const merged = loadMcpConfiguration(cwd, false);
			expect(merged.servers.get("shared")).toMatchObject({ type: "stdio", command: "plugin-server" });
			expect(merged.servers.get("plugin")).toMatchObject({ type: "stdio", command: "plugin-only" });
		} finally {
			clearPluginMcpConfiguration(cwd);
		}
	});

	it("uses opaque resource paths in plugin URIs", () => {
		const uri = pluginResourceUri("safe-plugin", "resources/private guide.md");
		expect(uri).toBe("plugin://safe-plugin/cmVzb3VyY2VzL3ByaXZhdGUgZ3VpZGUubWQ");
		expect(uri).not.toContain("private guide.md");
	});
});
