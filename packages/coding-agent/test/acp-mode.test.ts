import type {
	ClientCapabilities,
	ContentBlock,
	CreateTerminalRequest,
	McpServer,
	ReadTextFileRequest,
	WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	convertAcpMcpServers,
	convertAcpPromptContent,
	createAcpToolDefinitionOverrides,
	mapAcpToolKind,
} from "../src/modes/acp/acp-mode.ts";

describe("ACP mode", () => {
	it("is selectable from the CLI", () => {
		expect(parseArgs(["--mode", "acp"]).mode).toBe("acp");
	});

	it("converts prompt text, images, links, and embedded resources", () => {
		const prompt: ContentBlock[] = [
			{ type: "text", text: "检查这个文件" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			{ type: "resource_link", name: "source", uri: "file:///workspace/index.ts" },
			{
				type: "resource",
				resource: { uri: "memory://note", text: "重要上下文", mimeType: "text/plain" },
			},
		];
		const result = convertAcpPromptContent(prompt);
		expect(result.text).toContain("检查这个文件");
		expect(result.text).toContain("file:///workspace/index.ts");
		expect(result.text).toContain("重要上下文");
		expect(result.images).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
	});

	it("converts session MCP servers without persisting secrets", () => {
		const servers: McpServer[] = [
			{
				name: "Local Tools",
				command: "C:/tools/server.exe",
				args: ["--stdio"],
				env: [{ name: "TOKEN", value: "secret" }],
			},
			{
				type: "http",
				name: "Remote",
				url: "https://mcp.example.com",
				headers: [{ name: "Authorization", value: "Bearer secret" }],
			},
		];
		const result = convertAcpMcpServers(servers);
		expect(result.get("local-tools")).toMatchObject({ type: "stdio", command: "C:/tools/server.exe" });
		expect(result.get("remote")).toMatchObject({ type: "http", url: "https://mcp.example.com" });
	});

	it("maps tools to ACP display kinds", () => {
		expect(mapAcpToolKind("read")).toBe("read");
		expect(mapAcpToolKind("ast_edit")).toBe("edit");
		expect(mapAcpToolKind("lsp")).toBe("search");
		expect(mapAcpToolKind("bash")).toBe("execute");
		expect(mapAcpToolKind("web_fetch")).toBe("fetch");
	});

	it("routes advertised text file capabilities through the ACP client", async () => {
		const reads: ReadTextFileRequest[] = [];
		const writes: WriteTextFileRequest[] = [];
		const capabilities: ClientCapabilities = {
			fs: { readTextFile: true, writeTextFile: true },
		};
		const overrides = createAcpToolDefinitionOverrides("C:\\workspace", "session-1", capabilities, {
			async readTextFile(request) {
				reads.push(request);
				return { content: "hello from editor\n" };
			},
			async writeTextFile(request) {
				writes.push(request);
				return {};
			},
			async createTerminal(_request: CreateTerminalRequest) {
				throw new Error("terminal should not be called");
			},
		});

		const read = overrides.read;
		const write = overrides.write;
		expect(read).toBeDefined();
		expect(write).toBeDefined();
		const readResult = await read?.execute(
			"read-1",
			{ path: "note.txt", mode: "full" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await write?.execute(
			"write-1",
			{ path: "note.txt", content: "updated by editor\n" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(reads).toEqual([
			{ sessionId: "session-1", path: expect.stringMatching(/workspace[\\/]note\.txt$/) },
			{ sessionId: "session-1", path: expect.stringMatching(/workspace[\\/]note\.txt$/) },
		]);
		expect(writes).toEqual([
			{
				sessionId: "session-1",
				path: expect.stringMatching(/workspace[\\/]note\.txt$/),
				content: "updated by editor\n",
			},
		]);
		expect(readResult?.content[0]).toMatchObject({ type: "text" });
	});

	it("routes terminal execution and always releases the ACP handle", async () => {
		const terminals: CreateTerminalRequest[] = [];
		let released = 0;
		const overrides = createAcpToolDefinitionOverrides(
			"C:\\workspace",
			"session-1",
			{ terminal: true },
			{
				async readTextFile() {
					throw new Error("fs should not be called");
				},
				async writeTextFile() {
					throw new Error("fs should not be called");
				},
				async createTerminal(request) {
					terminals.push(request);
					return {
						id: "terminal-1",
						async currentOutput() {
							return { output: "terminal output\n", truncated: false, exitStatus: { exitCode: 0 } };
						},
						async waitForExit() {
							return { exitCode: 0 };
						},
						async kill() {
							return {};
						},
						async release() {
							released += 1;
							return {};
						},
					};
				},
			},
		);

		const bash = overrides.bash;
		expect(bash).toBeDefined();
		const result = await bash?.execute(
			"bash-1",
			{ command: "Write-Output routed", executor: process.platform === "win32" ? "powershell" : "bash" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({ sessionId: "session-1", cwd: "C:\\workspace" });
		expect(result?.content[0]).toMatchObject({ type: "text", text: "terminal output\n" });
		expect(released).toBe(1);
	});

	it("keeps local tools when the client advertises no matching capabilities", () => {
		const overrides = createAcpToolDefinitionOverrides(
			"C:\\workspace",
			"session-1",
			{},
			{
				async readTextFile() {
					throw new Error("not called");
				},
				async writeTextFile() {
					throw new Error("not called");
				},
				async createTerminal() {
					throw new Error("not called");
				},
			},
		);

		expect(overrides).toEqual({});
	});
});
