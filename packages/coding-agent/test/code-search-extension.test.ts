import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import codeSearchExtension from "../src/extensions/code-search/index.ts";
import {
	cleanMgrepOutput,
	formatMgrepError,
	isMgrepWatchReady,
	MgrepProcessError,
	resolveMgrepMaxFileCount,
} from "../src/extensions/code-search/process.ts";
import { CodeSearchService, resolveProjectSearchPath } from "../src/extensions/code-search/search.ts";
import type { MgrepOperations, MgrepSearchOptions, MgrepWatchHandle } from "../src/extensions/code-search/types.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-code-search-"));
	tempDirectories.push(directory);
	return realpath(directory);
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function readyWatcher(): MgrepWatchHandle {
	let running = true;
	return {
		ready: Promise.resolve(),
		isRunning: () => running,
		stop: () => {
			running = false;
		},
	};
}

interface ControlledWatcher extends MgrepWatchHandle {
	resolveReady(): void;
}

function controlledWatcher(): ControlledWatcher {
	let running = true;
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	return {
		ready,
		isRunning: () => running,
		stop: () => {
			running = false;
		},
		resolveReady,
	};
}

function fakeOperations(overrides: Partial<MgrepOperations> = {}): MgrepOperations {
	return {
		maxFileCount: 5000,
		startWatch: () => readyWatcher(),
		search: async () => ".\\src\\auth.ts:10-18 (95.00% match)\nexport function authenticate() {}",
		...overrides,
	};
}

describe("code search extension", () => {
	test("registers one semantic code-search tool with concise Chinese guidance", () => {
		const tools: ToolDefinition[] = [];
		codeSearchExtension({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: () => {},
		} as unknown as ExtensionAPI);

		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("code_search");
		expect(tools[0]?.description).toContain("按意思");
		const guidance = tools[0]?.promptGuidelines?.join(" ") ?? "";
		expect(guidance).toContain("当前上下文已经足够回答");
		expect(guidance).toContain("准确路径、符号和关键词都未知");
		expect(guidance).toContain("配置位置");
		expect(guidance).toContain("不要使用 code_search");
		expect(guidance).toContain("完整证据链");
		expect(guidance).toContain("12");
		expect(guidance).toContain("20");
		expect(guidance).toContain("grep");
		expect(guidance).toContain("read");
		expect(tools[0]?.parameters).toMatchObject({
			properties: {
				path: { description: expect.stringContaining("普通项目仍会完整索引") },
				max_results: { maximum: 20 },
			},
		});
	});

	test("explains one-time install and login with an expected wait", () => {
		const message = formatMgrepError(new MgrepProcessError("not-installed", "spawn mgrep ENOENT"));

		expect(message).toContain("npm install -g @mixedbread/mgrep");
		expect(message).toContain("mgrep login");
		expect(message).toContain("1–2 分钟");
	});

	test("uses a safe default file limit and respects an explicit environment override", () => {
		expect(resolveMgrepMaxFileCount(undefined)).toBe(5000);
		expect(resolveMgrepMaxFileCount("2000")).toBe(2000);
		expect(resolveMgrepMaxFileCount("invalid")).toBe(5000);
	});

	test("cleans terminal control output before showing it to the model", () => {
		expect(cleanMgrepOutput("\u001B[32mready\u001B[0m\rindexing\rcomplete\u0000")).toBe("ready\nindexing\ncomplete");
	});

	test("waits for initial sync instead of the watcher's early startup message", () => {
		expect(isMgrepWatchReady("Watching for file changes in C:\\project")).toBe(false);
		expect(isMgrepWatchReady("Initial sync complete (120/120) • uploaded 120")).toBe(true);
	});
});

describe("code search service", () => {
	test("rejects paths outside the current project", async () => {
		const project = await createTempDirectory();
		const outside = await createTempDirectory();

		await expect(resolveProjectSearchPath(project, outside)).rejects.toThrow("当前项目");
	});

	test("starts indexing once, explains the wait, and searches with a compact result limit", async () => {
		const project = await createTempDirectory();
		const watcher = readyWatcher();
		const startWatch = vi.fn(() => watcher);
		const calls: MgrepSearchOptions[] = [];
		const operations = fakeOperations({
			startWatch,
			search: async (options) => {
				calls.push(options);
				return ".\\src\\auth.ts:10-18 (95.00% match)\nexport function authenticate() {}";
			},
		});
		const service = new CodeSearchService(operations);
		const updates: string[] = [];

		const first = await service.search(
			{ query: "用户登录在哪里实现", maxResults: 6 },
			project,
			undefined,
			(message) => updates.push(message),
		);
		const second = await service.search({ query: "API Key 保存逻辑" }, project, undefined, (message) =>
			updates.push(message),
		);
		await service.search({ query: "技能加载调用链", maxResults: 20 }, project);

		expect(startWatch).toHaveBeenCalledOnce();
		expect(startWatch).toHaveBeenCalledWith({ cwd: project, maxFileCount: 5000 }, expect.any(Function));
		expect(updates.some((message) => message.includes("前台最多等待 2 秒"))).toBe(true);
		expect(updates.some((message) => message.includes("超过 15 秒"))).toBe(true);
		expect(calls[0]).toMatchObject({ query: "用户登录在哪里实现", maxResults: 6, cwd: project, path: "." });
		expect(calls[1]).toMatchObject({ maxResults: 6 });
		expect(calls[2]).toMatchObject({ maxResults: 20 });
		expect(first.text).toContain("src/auth.ts");
		expect(second.details.truncated).toBe(false);
		expect(second.details.indexPath).toBe(".");
		expect(second.details.maxFileCount).toBe(5000);
	});

	test("returns quickly while a healthy watcher keeps indexing in the background", async () => {
		const project = await createTempDirectory();
		const watcher = controlledWatcher();
		const stop = vi.spyOn(watcher, "stop");
		const search = vi.fn(async () => ".\\src\\auth.ts:10-18 (95.00% match)\nexport function authenticate() {}");
		const service = new CodeSearchService(fakeOperations({ startWatch: () => watcher, search }), {
			foregroundWaitMs: 5,
		});
		const startedAt = Date.now();

		try {
			await service.search({ query: "认证流程如何实现" }, project);
			expect.unreachable("search should fall back while indexing");
		} catch (error) {
			const message = formatMgrepError(error);
			expect(message).toContain("后台准备");
			expect(message).toContain("本次跳过");
			expect(message).toContain("内置 grep");
		}

		expect(Date.now() - startedAt).toBeLessThan(200);
		expect(stop).not.toHaveBeenCalled();
		expect(search).not.toHaveBeenCalled();

		watcher.resolveReady();
		await watcher.ready;
		const result = await service.search({ query: "认证流程如何实现" }, project);

		expect(result.text).toContain("src/auth.ts");
		expect(search).toHaveBeenCalledOnce();
	});

	test("narrows indexing to an explicit path when the whole project exceeds the safe limit", async () => {
		const project = await createTempDirectory();
		const scopedDirectory = path.join(project, "packages", "coding-agent");
		await mkdir(scopedDirectory, { recursive: true });
		const watchRoots: string[] = [];
		const operations = fakeOperations({
			startWatch: (options) => {
				watchRoots.push(options.cwd);
				if (options.cwd === project) {
					return {
						ready: Promise.reject(
							new MgrepProcessError(
								"file-limit",
								"Files to sync (6001) exceeds the maximum allowed (5000). No files were synced.",
							),
						),
						isRunning: () => false,
						stop: () => {},
					};
				}
				return readyWatcher();
			},
		});
		const service = new CodeSearchService(operations);

		const result = await service.search({ query: "技能如何加载", path: "packages/coding-agent" }, project);

		expect(watchRoots).toEqual([project, scopedDirectory]);
		expect(result.text).toContain("packages/coding-agent/src/auth.ts");
		expect(result.details.indexPath).toBe("packages/coding-agent");
	});

	test("indexes a file's parent directory while keeping the search limited to that file", async () => {
		const project = await createTempDirectory();
		const scopedDirectory = path.join(project, "src");
		const targetFile = path.join(scopedDirectory, "auth.ts");
		await mkdir(scopedDirectory, { recursive: true });
		await writeFile(targetFile, "export const apiKey = 'test';\n", "utf8");
		const watchRoots: string[] = [];
		const searchCalls: MgrepSearchOptions[] = [];
		const operations = fakeOperations({
			startWatch: (options) => {
				watchRoots.push(options.cwd);
				if (options.cwd === project) {
					return {
						ready: Promise.reject(
							new MgrepProcessError(
								"file-limit",
								"Files to sync (6001) exceeds the maximum allowed (5000). No files were synced.",
							),
						),
						isRunning: () => false,
						stop: () => {},
					};
				}
				return readyWatcher();
			},
			search: async (options) => {
				searchCalls.push(options);
				return ".\\auth.ts:1-1 (95.00% match)\nexport const apiKey = 'test';";
			},
		});
		const service = new CodeSearchService(operations);

		const result = await service.search({ query: "API Key", path: "src/auth.ts" }, project);

		expect(watchRoots).toEqual([project, scopedDirectory]);
		expect(searchCalls[0]).toMatchObject({ cwd: scopedDirectory, path: "auth.ts" });
		expect(result.text).toContain("./src/auth.ts:1-1");
		expect(result.details.indexPath).toBe("src");
	});

	test("does not retry the same oversized scope and directs fallback to built-in grep", async () => {
		const project = await createTempDirectory();
		const startWatch = vi.fn(() => ({
			ready: Promise.reject(
				new MgrepProcessError(
					"file-limit",
					"Files to sync (6001) exceeds the maximum allowed (5000). No files were synced.",
				),
			),
			isRunning: () => false,
			stop: () => {},
		}));
		const service = new CodeSearchService(fakeOperations({ startWatch }));

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await service.search({ query: "API Key 在哪里" }, project);
				expect.unreachable("search should fail");
			} catch (error) {
				const message = formatMgrepError(error);
				expect(message).toContain("6001 个文件");
				expect(message).toContain("不会重复检查同一范围");
				expect(message).toContain("内置 grep");
				expect(message).toContain("不要通过 bash 运行 rg");
			}
		}

		expect(startWatch).toHaveBeenCalledOnce();
	});

	test("does not retry either scope after the project and explicit path both exceed the limit", async () => {
		const project = await createTempDirectory();
		const scopedDirectory = path.join(project, "packages", "large-package");
		await mkdir(scopedDirectory, { recursive: true });
		const startWatch = vi.fn(() => ({
			ready: Promise.reject(
				new MgrepProcessError(
					"file-limit",
					"Files to sync (7000) exceeds the maximum allowed (5000). No files were synced.",
				),
			),
			isRunning: () => false,
			stop: () => {},
		}));
		const service = new CodeSearchService(fakeOperations({ startWatch }));

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				service.search({ query: "大型模块入口", path: "packages/large-package" }, project),
			).rejects.toThrow("范围 packages/large-package");
		}

		expect(startWatch).toHaveBeenCalledTimes(2);
	});

	test("stops the background watcher when the runtime shuts down", async () => {
		const project = await createTempDirectory();
		const stop = vi.fn();
		const watcher: MgrepWatchHandle = { ready: Promise.resolve(), isRunning: () => true, stop };
		const service = new CodeSearchService(fakeOperations({ startWatch: () => watcher }));

		await service.search({ query: "配置读取" }, project);
		service.stop();

		expect(stop).toHaveBeenCalledOnce();
	});
});
