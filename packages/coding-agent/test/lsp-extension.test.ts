import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CodeAction, Location, WorkspaceEdit } from "vscode-languageserver-protocol";
import type { ExtensionAPI, ToolDefinition, ToolResultEvent } from "../src/core/extensions/types.ts";
import { LspAutoDiagnostics } from "../src/extensions/lsp/auto-diagnostics.ts";
import { startLanguageClient } from "../src/extensions/lsp/client.ts";
import { createLspExtension } from "../src/extensions/lsp/index.ts";
import {
	detectLanguageAdapter,
	findLanguageWorkspaceRoot,
	formatLanguageServerSetup,
} from "../src/extensions/lsp/languages.ts";
import { applyWorkspaceEditSafely, LspService, resolveLspPosition } from "../src/extensions/lsp/service.ts";
import type { LanguageAdapter, LspClient, LspDocument, LspToolRequest } from "../src/extensions/lsp/types.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-lsp-"));
	tempDirectories.push(directory);
	return realpath(directory);
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LSP language adapters", () => {
	test.each([
		["index.ts", "typescript", "typescript"],
		["component.tsx", "typescript", "typescriptreact"],
		["index.js", "typescript", "javascript"],
		["component.jsx", "typescript", "javascriptreact"],
		["module.py", "python", "python"],
		["types.pyi", "python", "python"],
		["main.go", "go", "go"],
	])("recognizes %s as %s", (fileName, adapterId, languageId) => {
		const adapter = detectLanguageAdapter(fileName);

		expect(adapter?.id).toBe(adapterId);
		expect(adapter?.languageId(fileName)).toBe(languageId);
	});

	test("rejects unsupported file types", () => {
		expect(detectLanguageAdapter("README.md")).toBeUndefined();
	});

	test("finds the nearest language workspace marker without leaving the current project", async () => {
		const project = await createTempDirectory();
		const packageRoot = path.join(project, "packages", "app");
		const sourceDirectory = path.join(packageRoot, "src");
		const filePath = path.join(sourceDirectory, "index.ts");
		await mkdir(sourceDirectory, { recursive: true });
		await writeFile(path.join(project, "package.json"), "{}", "utf8");
		await writeFile(path.join(packageRoot, "tsconfig.json"), "{}", "utf8");
		await writeFile(filePath, "export const value = 1;\n", "utf8");
		const adapter = detectLanguageAdapter(filePath);

		expect(adapter).toBeDefined();
		await expect(findLanguageWorkspaceRoot(filePath, project, adapter!)).resolves.toBe(packageRoot);
	});

	test("falls back to the current project when no marker exists", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "src", "module.py");
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, "value = 1\n", "utf8");
		const adapter = detectLanguageAdapter(filePath);

		expect(adapter).toBeDefined();
		await expect(findLanguageWorkspaceRoot(filePath, project, adapter!)).resolves.toBe(project);
	});

	test("bundles TypeScript while giving short Python and Go setup commands", () => {
		const typescript = detectLanguageAdapter("index.ts");
		const python = detectLanguageAdapter("main.py");
		const go = detectLanguageAdapter("main.go");

		expect(typescript?.launchCandidates()).toEqual([
			{ command: process.execPath, args: [expect.stringContaining("typescript-language-server"), "--stdio"] },
		]);
		expect(formatLanguageServerSetup(typescript!)).toContain("直接使用");
		expect(formatLanguageServerSetup(python!)).toContain("pip install basedpyright");
		expect(formatLanguageServerSetup(go!)).toContain("go install golang.org/x/tools/gopls@latest");
	});
});

describe("LSP extension", () => {
	test("registers one compact Chinese tool and stops its service on shutdown", async () => {
		const tools: ToolDefinition[] = [];
		let shutdown: (() => Promise<void>) | undefined;
		const service = {
			execute: vi.fn(),
			stop: vi.fn(async () => {}),
		};
		createLspExtension(service)({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") shutdown = handler;
			},
		} as unknown as ExtensionAPI);

		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("lsp");
		expect(tools[0]?.description).toContain("定义、引用、类型、错误");
		const guidelines = tools[0]?.promptGuidelines?.join(" ") ?? "";
		expect(guidelines).toContain("只知道 symbol");
		expect(guidelines).toContain("先用 grep");
		expect(guidelines).toContain('diagnostics 可以把 "*" 作为 path');
		expect(guidelines).toContain('path="*"');
		expect(guidelines).toContain("grep 和 read");
		expect(guidelines).toContain("一批代码修改完成后");
		expect(tools[0]?.parameters).toMatchObject({
			properties: {
				operation: { anyOf: expect.arrayContaining([expect.objectContaining({ const: "rename" })]) },
				line: { minimum: 1 },
				column: { minimum: 1 },
				max_results: { maximum: 100 },
				path: { description: expect.stringContaining('"*"') },
			},
		});
		await shutdown?.();
		expect(service.stop).toHaveBeenCalledOnce();
	});

	test("feeds one batched diagnostic message into the next repair turn", async () => {
		type TestContext = {
			cwd: string;
			signal: AbortSignal | undefined;
			ui: {
				notify: ReturnType<typeof vi.fn>;
				setStatus: ReturnType<typeof vi.fn>;
			};
		};
		type TestHandler = (event: unknown, ctx: TestContext) => unknown;
		const handlers = new Map<string, TestHandler>();
		const sendMessage = vi.fn();
		const service = {
			warmup: vi.fn(async () => {}),
			execute: vi.fn(async () => ({
				text: "src/index.ts:1:1 [错误] 示例错误",
				details: {
					operation: "diagnostics" as const,
					language: "typescript" as const,
					workspaceRoot: "project",
					truncated: false,
					resultCount: 1,
				},
			})),
			stop: vi.fn(async () => {}),
		};
		createLspExtension(service, { timeoutMs: 100 })({
			registerTool: vi.fn(),
			on: (event: string, handler: TestHandler) => handlers.set(event, handler),
			getActiveTools: () => ["lsp"],
			sendMessage,
		} as unknown as ExtensionAPI);
		const ctx: TestContext = {
			cwd: "project",
			signal: undefined,
			ui: { notify: vi.fn(), setStatus: vi.fn() },
		};

		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await handlers.get("tool_result")?.(toolResult("edit", { path: "src/index.ts" }), ctx);
		expect(service.warmup).toHaveBeenCalledWith("src/index.ts", "project", expect.any(Function));
		await handlers.get("turn_end")?.({ type: "turn_end" }, ctx);

		expect(sendMessage).toHaveBeenCalledOnce();
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "lsp-auto-diagnostics",
				content: expect.stringContaining("示例错误"),
				display: true,
			}),
			{ deliverAs: "steer" },
		);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("lsp-auto-diagnostics", undefined);
	});
});

function toolResult(
	toolName: string,
	input: Record<string, unknown>,
	details?: unknown,
	isError = false,
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: `${toolName}-call`,
		toolName,
		input,
		content: [],
		details,
		isError,
	} as ToolResultEvent;
}

describe("automatic LSP diagnostics", () => {
	test("batches successful edits and only returns compact diagnostics", async () => {
		const service = {
			execute: vi.fn(async (request: { path: string }) => ({
				text: `${request.path}:1:1 [错误] 示例错误`,
				details: {
					operation: "diagnostics" as const,
					language: "typescript" as const,
					workspaceRoot: "project",
					truncated: false,
					resultCount: 1,
				},
			})),
		};
		const diagnostics = new LspAutoDiagnostics(service);
		diagnostics.recordToolResult(toolResult("edit", { path: "src/index.ts" }));
		diagnostics.recordToolResult(toolResult("write", { path: "src/index.ts", content: "" }));
		diagnostics.recordToolResult(toolResult("write", { path: "README.md", content: "" }));

		const result = await diagnostics.flush("project");

		expect(service.execute).toHaveBeenCalledOnce();
		expect(service.execute).toHaveBeenCalledWith(
			{ operation: "diagnostics", path: "src/index.ts", maxResults: 10 },
			"project",
			expect.any(AbortSignal),
			expect.any(Function),
		);
		expect(result.kind).toBe("diagnostics");
		expect(result.message).toContain("自动 LSP 检查发现 1 个问题");
		expect(result.message).toContain("src/index.ts:1:1");
	});

	test("confirms an empty diagnostic result once after a cold language server start", async () => {
		const service = {
			execute: vi.fn(
				async (
					_request: LspToolRequest,
					_cwd: string,
					_signal?: AbortSignal,
					onStatus?: (message: string) => void,
				) => {
					if (service.execute.mock.calls.length === 1) {
						onStatus?.("正在启动 TypeScript/JavaScript 语言服务器；第一次通常需要几秒。");
						return {
							text: "没有发现错误或警告。",
							details: {
								operation: "diagnostics" as const,
								language: "typescript" as const,
								workspaceRoot: "project",
								truncated: false,
								resultCount: 0,
							},
						};
					}
					return {
						text: "src/index.ts:1:7 [错误] 不能将类型 string 分配给类型 number",
						details: {
							operation: "diagnostics" as const,
							language: "typescript" as const,
							workspaceRoot: "project",
							truncated: false,
							resultCount: 1,
						},
					};
				},
			),
		};
		const diagnostics = new LspAutoDiagnostics(service);
		diagnostics.recordToolResult(toolResult("write", { path: "src/index.ts", content: "" }));

		const result = await diagnostics.flush("project");

		expect(service.execute).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ kind: "diagnostics", diagnosticCount: 1 });
		expect(result.message).toContain("不能将类型 string 分配给类型 number");
	});

	test("defers the first cold check while the language server warms in the background", async () => {
		let finishWarmup = () => {};
		const service = {
			warmup: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishWarmup = resolve;
					}),
			),
			execute: vi.fn(async () => ({
				text: "src/index.ts:1:7 [错误] 不能将类型 string 分配给类型 number",
				details: {
					operation: "diagnostics" as const,
					language: "typescript" as const,
					workspaceRoot: "project",
					truncated: false,
					resultCount: 1,
				},
			})),
		};
		const diagnostics = new LspAutoDiagnostics(service);
		diagnostics.recordToolResult(toolResult("write", { path: "src/index.ts", content: "" }), {
			cwd: "project",
		});

		await expect(diagnostics.flush("project")).resolves.toMatchObject({ kind: "deferred" });
		expect(service.execute).not.toHaveBeenCalled();
		expect(diagnostics.pendingFileCount).toBe(1);

		finishWarmup();
		await vi.waitFor(() => expect(service.warmup).toHaveResolved());

		await expect(diagnostics.flush("project")).resolves.toMatchObject({
			kind: "diagnostics",
			diagnosticCount: 1,
		});
		expect(service.execute).toHaveBeenCalledOnce();
	});

	test("tracks files changed by LSP rename and stays silent when they are clean", async () => {
		const service = {
			execute: vi.fn(async () => ({
				text: "没有发现错误或警告。",
				details: {
					operation: "diagnostics" as const,
					language: "typescript" as const,
					workspaceRoot: "project",
					truncated: false,
					resultCount: 0,
				},
			})),
		};
		const diagnostics = new LspAutoDiagnostics(service);
		diagnostics.recordToolResult(
			toolResult("lsp", { operation: "rename" }, { changedFiles: ["src/a.ts", "src/b.ts"] }),
		);

		const result = await diagnostics.flush("project");

		expect(service.execute).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ kind: "clean", checkedFiles: 2 });
		expect(result.message).toBeUndefined();
	});

	test("tracks files changed by structural editing", async () => {
		const service = {
			execute: vi.fn(async (request: { path: string }) => ({
				text: `${request.path}: clean`,
				details: {
					operation: "diagnostics" as const,
					language: "typescript" as const,
					workspaceRoot: "project",
					truncated: false,
					resultCount: 0,
				},
			})),
		};
		const diagnostics = new LspAutoDiagnostics(service);
		diagnostics.recordToolResult(
			toolResult(
				"ast_edit",
				{ pattern: "oldCall($A)", replacement: "newCall($A)" },
				{ changedFiles: ["src/a.ts", "src/b.ts"] },
			),
		);

		await expect(diagnostics.flush("project")).resolves.toMatchObject({ kind: "clean", checkedFiles: 2 });
		expect(service.execute).toHaveBeenCalledTimes(2);
	});

	test("stops automatic feedback after two diagnostic rounds", async () => {
		const service = {
			execute: vi.fn(async () => ({
				text: "src/index.ts:1:1 [错误] 示例错误",
				details: {
					operation: "diagnostics" as const,
					language: "typescript" as const,
					workspaceRoot: "project",
					truncated: false,
					resultCount: 1,
				},
			})),
		};
		const diagnostics = new LspAutoDiagnostics(service, { maxFeedbackRounds: 2 });

		for (let round = 0; round < 2; round++) {
			diagnostics.recordToolResult(toolResult("edit", { path: "src/index.ts" }));
			await expect(diagnostics.flush("project")).resolves.toMatchObject({ kind: "diagnostics" });
		}
		diagnostics.recordToolResult(toolResult("edit", { path: "src/index.ts" }));

		await expect(diagnostics.flush("project")).resolves.toMatchObject({
			kind: "limited",
			notice: expect.stringContaining("2 轮"),
		});
		expect(service.execute).toHaveBeenCalledTimes(2);
	});

	test("skips a slow check without waiting for the language server", async () => {
		const service = {
			execute: vi.fn(() => new Promise<never>(() => {})),
		};
		const diagnostics = new LspAutoDiagnostics(service, { timeoutMs: 5 });
		diagnostics.recordToolResult(toolResult("edit", { path: "src/index.ts" }));

		await expect(diagnostics.flush("project")).resolves.toMatchObject({
			kind: "skipped",
			notice: expect.stringContaining("超时"),
		});
	});
});

describe("standard LSP client", () => {
	test("uses the bundled TypeScript server for initialization, document sync, navigation, diagnostics, and rename", async () => {
		const project = await createTempDirectory();
		const definitionPath = path.join(project, "user.ts");
		const usagePath = path.join(project, "index.ts");
		await writeFile(
			path.join(project, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } }),
			"utf8",
		);
		await writeFile(
			definitionPath,
			"export interface User { name: string }\nexport function loadUser(): User { return { name: 'Pi' }; }\n",
			"utf8",
		);
		await writeFile(
			usagePath,
			"import { loadUser } from './user.js';\nconst user: number = loadUser();\nconsole.log(user);\n",
			"utf8",
		);
		const adapter = detectLanguageAdapter(usagePath);
		expect(adapter).toBeDefined();
		const client = await startLanguageClient(adapter!, project, {
			startupTimeoutMs: 15_000,
			broker: { enabled: false },
		});

		try {
			const document = await client.openDocument(usagePath);
			const position = { line: 1, character: 22 };
			const definitions = await client.definition(document, position);
			expect(definitions).toEqual(
				expect.arrayContaining([expect.objectContaining({ uri: expect.stringContaining("user.ts") })]),
			);
			const diagnostics = await client.diagnostics(document, undefined, 3_000);
			expect(diagnostics).toEqual(
				expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("User") })]),
			);
			const rename = await client.rename(document, position, "loadCurrentUser");
			expect(rename).not.toBeNull();
			expect(JSON.stringify(rename)).toContain("loadCurrentUser");
		} finally {
			await client.stop();
		}
	}, 25_000);
});

function fakeClient(adapter: LanguageAdapter, workspaceRoot: string, locations: Location[] = []): LspClient {
	return {
		adapter,
		workspaceRoot,
		capabilities: {},
		openDocument: async (filePath) => ({
			filePath,
			uri: pathToFileURL(filePath).href,
			languageId: adapter.languageId(filePath),
			version: 1,
			text: await readFile(filePath, "utf8"),
		}),
		definition: async () => locations,
		typeDefinition: async () => locations,
		references: async () => locations,
		implementation: async () => locations,
		hover: async () => ({ contents: { kind: "markdown", value: "```ts\nconst value: number\n```" } }),
		documentSymbols: async () => [],
		workspaceSymbols: async () => [],
		diagnostics: async () => [],
		rename: async () => null,
		codeActions: async () => [],
		resolveCodeAction: async (action) => action,
		executeCommand: async () => null,
		willRenameFiles: async () => null,
		didRenameFiles: async () => {},
		rawRequest: async () => null,
		refreshOpenDocument: async () => {},
		stop: async () => {},
	};
}

describe("LSP service", () => {
	test("supports status, type definitions, capabilities, raw requests, and targeted reload", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "index.ts");
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		await writeFile(filePath, "export const value = 1;\n", "utf8");
		const adapter = detectLanguageAdapter(filePath)!;
		const location: Location = {
			uri: pathToFileURL(filePath).href,
			range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
		};
		const client = fakeClient(adapter, project, [location]);
		Object.assign(client, {
			capabilities: { hoverProvider: true },
			rawRequest: vi.fn(async (_method: string, payload: unknown) => ({ payload })),
		});
		const factory = vi.fn(async () => client);
		const service = new LspService({ clientFactory: factory });

		const idle = await service.execute({ operation: "status", path: "." }, project);
		expect(idle.text).toContain("还没有启动");
		const typeDefinition = await service.execute(
			{ operation: "type_definition", path: "index.ts", symbol: "value" },
			project,
		);
		expect(typeDefinition.text).toContain("index.ts:1:14");
		const capabilities = await service.execute({ operation: "capabilities", path: "index.ts" }, project);
		expect(capabilities.text).toContain("hoverProvider");
		const raw = await service.execute(
			{ operation: "request", path: "index.ts", method: "custom/inspect", payload: '{"limit":2}' },
			project,
		);
		expect(raw.text).toContain('"limit": 2');
		const ready = await service.execute({ operation: "status", path: "." }, project);
		expect(ready.text).toContain("typescript · ready");

		await service.execute({ operation: "reload", path: "index.ts" }, project);
		expect(factory).toHaveBeenCalledTimes(2);
		await service.stop();
	});

	test("previews and applies one exact code action", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "index.ts");
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		await writeFile(filePath, "let value = 1;\n", "utf8");
		const adapter = detectLanguageAdapter(filePath)!;
		const action: CodeAction = {
			title: "Use const",
			kind: "quickfix",
			isPreferred: true,
			edit: {
				changes: {
					[pathToFileURL(filePath).href]: [
						{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "const" },
					],
				},
			},
		};
		const client = fakeClient(adapter, project);
		client.codeActions = async () => [action];
		const service = new LspService({ clientFactory: async () => client });

		const preview = await service.execute({ operation: "code_actions", path: "index.ts" }, project);
		expect(preview.text).toContain("Use const [quickfix] · 推荐");
		expect(await readFile(filePath, "utf8")).toBe("let value = 1;\n");

		const applied = await service.execute(
			{ operation: "code_actions", path: "index.ts", query: "Use const", apply: true },
			project,
		);
		expect(applied.details.changedFiles).toEqual(["index.ts"]);
		expect(await readFile(filePath, "utf8")).toBe("const value = 1;\n");
		await service.stop();
	});

	test("renames a file and applies language-server reference edits", async () => {
		const project = await createTempDirectory();
		const oldPath = path.join(project, "old.ts");
		const newPath = path.join(project, "new.ts");
		const consumerPath = path.join(project, "consumer.ts");
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		await writeFile(oldPath, "export const value = 1;\n", "utf8");
		await writeFile(consumerPath, "old.ts\n", "utf8");
		const adapter = detectLanguageAdapter(oldPath)!;
		const client = fakeClient(adapter, project);
		Object.assign(client, { capabilities: { workspace: { fileOperations: { willRename: true } } } });
		client.willRenameFiles = async () => ({
			changes: {
				[pathToFileURL(consumerPath).href]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "new.ts" },
				],
			},
		});
		const didRename = vi.spyOn(client, "didRenameFiles");
		const service = new LspService({ clientFactory: async () => client });

		const result = await service.execute({ operation: "rename_file", path: "old.ts", newPath: "new.ts" }, project);

		expect(result.details.changedFiles).toEqual(expect.arrayContaining(["new.ts", "consumer.ts"]));
		await expect(readFile(oldPath, "utf8")).rejects.toThrow();
		expect(await readFile(newPath, "utf8")).toContain("value");
		expect(await readFile(consumerPath, "utf8")).toBe("new.ts\n");
		expect(didRename).toHaveBeenCalledWith(oldPath, newPath);
		await service.stop();
	});

	test("warms a document in the background and reuses its client for diagnostics", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "index.ts");
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		await writeFile(filePath, "const value = 1;\n", "utf8");
		const adapter = detectLanguageAdapter(filePath)!;
		const client = fakeClient(adapter, project);
		const openDocument = vi.spyOn(client, "openDocument");
		const factory = vi.fn(async () => client);
		const service = new LspService({ clientFactory: factory });
		const status = vi.fn();

		await service.warmup("index.ts", project, status);
		await service.execute({ operation: "diagnostics", path: "index.ts" }, project, undefined, status);

		expect(factory).toHaveBeenCalledOnce();
		expect(status).toHaveBeenCalledOnce();
		expect(openDocument).toHaveBeenCalledTimes(2);
		await service.stop();
	});

	test("converts one-based line and column and resolves an exact unique symbol", () => {
		const document: LspDocument = {
			filePath: "index.ts",
			uri: "file:///index.ts",
			languageId: "typescript",
			version: 1,
			text: "const first = 1;\nconst target = first;\n",
		};

		expect(resolveLspPosition(document, { line: 2, column: 7 })).toEqual({ line: 1, character: 6 });
		expect(resolveLspPosition(document, { symbol: "target" })).toEqual({ line: 1, character: 6 });
	});

	test("reports candidate lines instead of guessing an ambiguous symbol", () => {
		const document: LspDocument = {
			filePath: "index.ts",
			uri: "file:///index.ts",
			languageId: "typescript",
			version: 1,
			text: "const value = 1;\nconsole.log(value);\n",
		};

		expect(() => resolveLspPosition(document, { symbol: "value" })).toThrow("第 1、2 行");
	});

	test("reuses one client per language workspace and formats compact one-based locations", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "index.ts");
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		await writeFile(filePath, "export const value = 1;\n", "utf8");
		const adapter = detectLanguageAdapter(filePath)!;
		const location: Location = {
			uri: pathToFileURL(filePath).href,
			range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
		};
		const client = fakeClient(adapter, project, [location]);
		const factory = vi.fn(async () => client);
		const service = new LspService({ clientFactory: factory });
		const status = vi.fn();

		const first = await service.execute(
			{ operation: "definition", path: "index.ts", symbol: "value" },
			project,
			undefined,
			status,
		);
		const second = await service.execute(
			{ operation: "references", path: "index.ts", symbol: "value" },
			project,
			undefined,
			status,
		);

		expect(factory).toHaveBeenCalledOnce();
		expect(status).toHaveBeenCalledOnce();
		expect(first.text).toContain("index.ts:1:14");
		expect(second.details.resultCount).toBe(1);
		await service.stop();
	});

	test.each([
		["main.py", "value = 1\n", "pip install basedpyright"],
		["main.go", "package main\n", "go install golang.org/x/tools/gopls@latest"],
	])("shows the matching setup hint before first startup for %s", async (fileName, content, setupCommand) => {
		const project = await createTempDirectory();
		const filePath = path.join(project, fileName);
		await writeFile(filePath, content, "utf8");
		const adapter = detectLanguageAdapter(filePath)!;
		const factory = vi.fn(async () => fakeClient(adapter, project));
		const service = new LspService({ clientFactory: factory });
		const status = vi.fn();

		await service.execute({ operation: "symbols", path: fileName }, project, undefined, status);
		await service.execute({ operation: "symbols", path: fileName }, project, undefined, status);

		expect(status).toHaveBeenCalledOnce();
		expect(status).toHaveBeenCalledWith(expect.stringContaining(setupCommand));
		await service.stop();
	});

	test("caches a terminal startup failure for the session", async () => {
		const project = await createTempDirectory();
		const filePath = path.join(project, "main.py");
		await writeFile(filePath, "value = 1\n", "utf8");
		const factory = vi.fn(async () => {
			throw new Error("spawn ENOENT");
		});
		const service = new LspService({ clientFactory: factory });

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(service.execute({ operation: "symbols", path: "main.py" }, project)).rejects.toThrow(
				"pip install basedpyright",
			);
		}
		expect(factory).toHaveBeenCalledOnce();
	});

	test("directs an unknown symbol path through grep before LSP", async () => {
		const project = await createTempDirectory();
		const service = new LspService({ clientFactory: vi.fn() });

		await expect(
			service.execute({ operation: "references", path: ".", symbol: "loadUser" }, project),
		).rejects.toThrow('先用内置 grep 搜索 "loadUser"');
		await expect(
			service.execute({ operation: "references", path: ".", symbol: "loadUser" }, project),
		).rejects.toThrow("找到具体文件和行号后再调用 lsp");
	});
});

describe("safe LSP rename edits", () => {
	test("applies multi-file edits from the end of each file", async () => {
		const project = await createTempDirectory();
		const firstPath = path.join(project, "first.ts");
		const secondPath = path.join(project, "second.ts");
		await writeFile(firstPath, "const oldName = oldName;\n", "utf8");
		await writeFile(secondPath, "oldName();\n", "utf8");
		const workspaceEdit: WorkspaceEdit = {
			changes: {
				[pathToFileURL(firstPath).href]: [
					{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "newName" },
					{ range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } }, newText: "newName" },
				],
				[pathToFileURL(secondPath).href]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: "newName" },
				],
			},
		};

		const result = await applyWorkspaceEditSafely(workspaceEdit, project);

		expect(result.editCount).toBe(3);
		expect(await readFile(firstPath, "utf8")).toBe("const newName = newName;\n");
		expect(await readFile(secondPath, "utf8")).toBe("newName();\n");
	});

	test("rejects project-external and overlapping edits before writing", async () => {
		const project = await createTempDirectory();
		const outside = await createTempDirectory();
		const outsidePath = path.join(outside, "outside.ts");
		const insidePath = path.join(project, "inside.ts");
		await writeFile(outsidePath, "oldName\n", "utf8");
		await writeFile(insidePath, "oldName\n", "utf8");
		const outsideEdit: WorkspaceEdit = {
			changes: {
				[pathToFileURL(outsidePath).href]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: "newName" },
				],
			},
		};
		const overlappingEdit: WorkspaceEdit = {
			changes: {
				[pathToFileURL(insidePath).href]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: "new" },
					{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } }, newText: "Name" },
				],
			},
		};

		await expect(applyWorkspaceEditSafely(outsideEdit, project)).rejects.toThrow("当前项目");
		await expect(applyWorkspaceEditSafely(overlappingEdit, project)).rejects.toThrow("重叠");
		expect(await readFile(insidePath, "utf8")).toBe("oldName\n");
	});

	test("rolls back files already written when a later write fails", async () => {
		const project = path.resolve("virtual-project");
		const firstPath = path.join(project, "first.ts");
		const secondPath = path.join(project, "second.ts");
		const contents = new Map([
			[firstPath, "oldName\n"],
			[secondPath, "oldName\n"],
		]);
		let secondWriteFailed = false;
		const workspaceEdit: WorkspaceEdit = {
			changes: {
				[pathToFileURL(firstPath).href]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: "newName" },
				],
				[pathToFileURL(secondPath).href]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: "newName" },
				],
			},
		};

		await expect(
			applyWorkspaceEditSafely(workspaceEdit, project, {
				fileSystem: {
					realpath: async (filePath) => filePath,
					readFile: async (filePath) => contents.get(filePath) ?? "",
					writeFile: async (filePath, content) => {
						if (filePath === secondPath && !secondWriteFailed) {
							secondWriteFailed = true;
							throw new Error("disk full");
						}
						contents.set(filePath, content);
					},
				},
			}),
		).rejects.toThrow("已恢复原文件");
		expect(contents.get(firstPath)).toBe("oldName\n");
		expect(contents.get(secondPath)).toBe("oldName\n");
	});
});
