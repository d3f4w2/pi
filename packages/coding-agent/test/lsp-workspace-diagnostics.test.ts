import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LspService } from "../src/extensions/lsp/service.ts";
import { runWorkspaceDiagnostics, type WorkspaceCommandRunner } from "../src/extensions/lsp/workspace-diagnostics.ts";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-lsp-workspace-")));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LSP workspace diagnostics", () => {
	test("runs bundled TypeScript without npx and truncates diagnostic lines", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		const runner = vi.fn<WorkspaceCommandRunner>(async () => ({
			kind: "exited",
			code: 2,
			stdout: "src/a.ts(1,1): error TS1: first\nsrc/b.ts(2,1): error TS2: second\n",
			stderr: "",
		}));

		const result = await runWorkspaceDiagnostics(project, undefined, { runner, maxResults: 1 });

		expect(runner).toHaveBeenCalledWith(
			process.execPath,
			expect.arrayContaining([expect.stringContaining("typescript"), "--noEmit", "--pretty", "false"]),
			project,
			undefined,
			expect.any(Number),
		);
		expect(result.details).toMatchObject({ language: "typescript", resultCount: 2, truncated: true });
		expect(result.text).toContain("src/a.ts");
		expect(result.text).not.toContain("src/b.ts");
	});

	test("falls back from basedpyright to pyright and explains missing Python tools", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "pyproject.toml"), "", "utf8");
		const runner = vi.fn<WorkspaceCommandRunner>(async (command) =>
			command === "basedpyright"
				? { kind: "not_found", stdout: "", stderr: "" }
				: { kind: "exited", code: 1, stdout: "main.py:1:1 - error: example\n", stderr: "" },
		);

		const result = await runWorkspaceDiagnostics(project, undefined, { runner });

		expect(runner.mock.calls.map(([command]) => command)).toEqual(["basedpyright", "pyright"]);
		expect(result.details.language).toBe("python");
		expect(result.text).toContain("main.py:1:1");

		runner.mockResolvedValue({ kind: "not_found", stdout: "", stderr: "" });
		const missing = await runWorkspaceDiagnostics(project, undefined, { runner });
		expect(missing.text).toContain("pip install basedpyright");
	});

	test("runs a Go module build and reports a clean project", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "go.mod"), "module example.com/test\n", "utf8");
		const runner = vi.fn<WorkspaceCommandRunner>(async () => ({
			kind: "exited",
			code: 0,
			stdout: "",
			stderr: "",
		}));

		const result = await runWorkspaceDiagnostics(project, undefined, { runner });

		expect(runner).toHaveBeenCalledWith("go", ["build", "./..."], project, undefined, expect.any(Number));
		expect(result.details).toMatchObject({ language: "go", resultCount: 0, truncated: false });
		expect(result.text).toContain("项目检查通过");
	});

	test("builds every module listed by a Go workspace", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "go.work"), "go 1.24\nuse ./apps/api\nuse ./libs/core\n", "utf8");
		const runner = vi.fn<WorkspaceCommandRunner>(async (_command, args) =>
			args[0] === "work"
				? {
						kind: "exited",
						code: 0,
						stdout: JSON.stringify({ Use: [{ DiskPath: "./apps/api" }, { DiskPath: "./libs/core" }] }),
						stderr: "",
					}
				: { kind: "exited", code: 0, stdout: "", stderr: "" },
		);

		await runWorkspaceDiagnostics(project, undefined, { runner });

		expect(runner).toHaveBeenNthCalledWith(
			1,
			"go",
			["work", "edit", "-json"],
			project,
			undefined,
			expect.any(Number),
		);
		expect(runner).toHaveBeenNthCalledWith(
			2,
			"go",
			["build", "./apps/api/...", "./libs/core/..."],
			project,
			undefined,
			expect.any(Number),
		);
	});

	test("returns guidance without spawning a command for an unknown project", async () => {
		const project = await createTempDirectory();
		const runner = vi.fn<WorkspaceCommandRunner>();

		const result = await runWorkspaceDiagnostics(project, undefined, { runner });

		expect(runner).not.toHaveBeenCalled();
		expect(result.details.language).toBe("unknown");
		expect(result.text).toContain("没有识别到");
	});

	test("stops a slow project check without blocking the task", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		const runner = vi.fn<WorkspaceCommandRunner>(async () => ({
			kind: "timed_out",
			stdout: "",
			stderr: "",
		}));

		const result = await runWorkspaceDiagnostics(project, undefined, { runner, timeoutMs: 25 });

		expect(result.text).toContain("超过 25ms");
		expect(result.text).toContain("任务可以继续");
	});

	test("routes diagnostics path star through the service without starting a language server", async () => {
		const project = await createTempDirectory();
		await writeFile(path.join(project, "tsconfig.json"), "{}", "utf8");
		const runner = vi.fn<WorkspaceCommandRunner>(async () => ({
			kind: "exited",
			code: 0,
			stdout: "",
			stderr: "",
		}));
		const clientFactory = vi.fn();
		const service = new LspService({ clientFactory, workspaceDiagnostics: { runner } });

		const result = await service.execute({ operation: "diagnostics", path: "*" }, project);

		expect(result.details.language).toBe("typescript");
		expect(clientFactory).not.toHaveBeenCalled();
		await expect(service.execute({ operation: "definition", path: "*" }, project)).rejects.toThrow(
			'路径 "*" 只支持 diagnostics',
		);
	});
});
