import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CallToolResult,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
	Tool,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { fingerprintMcpServer, loadMcpConfiguration } from "../src/extensions/mcp/config.ts";
import { convertMcpToolResult } from "../src/extensions/mcp/manager.ts";
import { McpOAuthProvider } from "../src/extensions/mcp/oauth.ts";
import { startOAuthCallbackServer } from "../src/extensions/mcp/oauth-callback.ts";
import { toToolDescriptor } from "../src/extensions/mcp/types.ts";

const temporaryDirectories: string[] = [];
const previousAgentDir = process.env[ENV_AGENT_DIR];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-mcp-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("MCP configuration", () => {
	it("merges trusted project servers and honors disabled servers", async () => {
		const root = await temporaryDirectory();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		await writeFile(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					local: { command: "node", args: ["server.js"], env: { TOKEN: "$MCP_TOKEN" } },
					disabled: { url: "https://example.com/mcp" },
				},
				disabledServers: ["disabled"],
			}),
		);
		await writeFile(
			join(projectDir, ".pi", "mcp.json"),
			JSON.stringify({
				mcpServers: { remote: { url: "https://mcp.example.com/api", headers: { Authorization: "$TOKEN" } } },
			}),
		);

		const untrusted = loadMcpConfiguration(projectDir, false);
		expect([...untrusted.servers.keys()]).toEqual(["local"]);
		const trusted = loadMcpConfiguration(projectDir, true);
		expect([...trusted.servers.keys()]).toEqual(["local", "remote"]);
		expect(trusted.errors).toEqual([]);
	});

	it("rejects credentials in URLs and reports invalid server names", async () => {
		const root = await temporaryDirectory();
		process.env[ENV_AGENT_DIR] = root;
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				mcpServers: { "Bad Name": { command: "x" }, secret: { url: "https://user:pass@example.com" } },
			}),
		);
		const config = loadMcpConfiguration(root, false);
		expect(config.servers.size).toBe(0);
		expect(config.errors.join("\n")).toContain("服务器名 Bad Name 无效");
		expect(config.errors.join("\n")).toContain("不能包含用户名或密码");
	});

	it("does not put secret values into cache fingerprints", () => {
		const first = fingerprintMcpServer({
			type: "stdio",
			command: "server",
			args: [],
			env: { TOKEN: "secret-one" },
			timeoutMs: 1_000,
		});
		const second = fingerprintMcpServer({
			type: "stdio",
			command: "server",
			args: [],
			env: { TOKEN: "secret-two" },
			timeoutMs: 1_000,
		});
		expect(first).toBe(second);
		expect(first).not.toContain("secret");
	});

	it("parses OAuth metadata without putting tokens in MCP configuration", async () => {
		const root = await temporaryDirectory();
		process.env[ENV_AGENT_DIR] = root;
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					remote: {
						url: "https://mcp.example.com/api",
						oauth: { clientId: "pi-public", scope: "mcp:tools", callbackPort: 33419 },
					},
				},
			}),
		);

		const config = loadMcpConfiguration(root, false).servers.get("remote");
		expect(config).toMatchObject({
			type: "http",
			oauth: { clientId: "pi-public", scope: "mcp:tools", callbackPort: 33419 },
		});
		expect(JSON.stringify(config)).not.toMatch(/access_token|refresh_token/i);
	});
});

describe("MCP OAuth provider", () => {
	it("persists PKCE state, client registration, and tokens in shared auth storage", async () => {
		const storage = AuthStorage.inMemory();
		const options = {
			serverName: "remote",
			serverUrl: "https://mcp.example.com/api",
			redirectUrl: new URL("http://127.0.0.1:33419/callback"),
			oauth: { callbackPort: 33419, scope: "mcp:tools" },
			storage,
		};
		const provider = new McpOAuthProvider(options);
		const state = await provider.state();
		expect(await provider.validateState(state)).toBe(true);
		await provider.saveCodeVerifier("verifier");
		expect(await provider.codeVerifier()).toBe("verifier");

		const client = { client_id: "registered", issuer: "https://auth.example.com" } as StoredOAuthClientInformation;
		const tokens = {
			access_token: "access-secret",
			token_type: "Bearer",
			refresh_token: "refresh-secret",
			expires_in: 3600,
			issuer: "https://auth.example.com",
		} as StoredOAuthTokens;
		await provider.saveClientInformation(client, { issuer: "https://auth.example.com" });
		await provider.saveTokens(tokens, { issuer: "https://auth.example.com" });

		const restored = new McpOAuthProvider(options);
		expect(await restored.clientInformation({ issuer: "https://auth.example.com" })).toEqual(client);
		expect(await restored.tokens()).toEqual(tokens);
		expect(await storage.list()).toEqual([{ providerId: expect.stringMatching(/^mcp:/), type: "oauth" }]);
	});

	it("accepts one loopback callback and returns only its parameters", async () => {
		const server = await startOAuthCallbackServer(new URL("http://127.0.0.1:0/callback"), { timeoutMs: 2_000 });
		try {
			const response = await fetch(`${server.redirectUrl}?code=code-1&state=state-1`);
			expect(response.status).toBe(200);
			const params = await server.wait();
			expect(params.get("code")).toBe("code-1");
			expect(params.get("state")).toBe("state-1");
		} finally {
			await server.close();
		}
	});
});

describe("MCP tool bridge", () => {
	it("preserves schemas and maps read-only annotations", () => {
		const tool = {
			name: "lookup",
			description: "Read an item",
			inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			annotations: { readOnlyHint: true },
		} as Tool;
		expect(toToolDescriptor(tool)).toMatchObject({ name: "lookup", readOnly: true, inputSchema: tool.inputSchema });
	});

	it("converts text, images, resources, and structured output", () => {
		const result = {
			content: [
				{ type: "text", text: "done" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "resource_link", uri: "memo://one", name: "memo" },
			],
			structuredContent: { count: 1 },
		} as CallToolResult;
		const converted = convertMcpToolResult(result);
		expect(converted[0]).toEqual({ type: "text", text: "done" });
		expect(converted[1]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(converted.map((item) => (item.type === "text" ? item.text : "")).join("\n")).toContain("结构化结果");
	});
});
