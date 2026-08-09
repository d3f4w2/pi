import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isBunBinary } from "../../config.ts";
import type { LanguageAdapter } from "./types.ts";

const require = createRequire(import.meta.url);
const typescriptLanguageServerPath = isBunBinary
	? undefined
	: require.resolve("typescript-language-server/lib/cli.mjs");

const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
	{
		id: "typescript",
		displayName: "TypeScript/JavaScript",
		extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
		languageId(filePath) {
			switch (path.extname(filePath).toLowerCase()) {
				case ".tsx":
					return "typescriptreact";
				case ".js":
				case ".mjs":
				case ".cjs":
					return "javascript";
				case ".jsx":
					return "javascriptreact";
				default:
					return "typescript";
			}
		},
		launchCandidates: () =>
			typescriptLanguageServerPath
				? [{ command: process.execPath, args: [typescriptLanguageServerPath, "--stdio"] }]
				: [{ command: "typescript-language-server", args: ["--stdio"] }],
	},
	{
		id: "python",
		displayName: "Python",
		extensions: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "uv.lock", "requirements.txt", "setup.cfg", "setup.py"],
		languageId: () => "python",
		launchCandidates: () => [
			{ command: "basedpyright-langserver", args: ["--stdio"] },
			{ command: "pyright-langserver", args: ["--stdio"] },
			{ command: "pylsp", args: [] },
		],
	},
	{
		id: "go",
		displayName: "Go",
		extensions: [".go"],
		rootMarkers: ["go.work", "go.mod"],
		languageId: () => "go",
		launchCandidates: () => [{ command: "gopls", args: [] }],
	},
];

export function detectLanguageAdapter(filePath: string): LanguageAdapter | undefined {
	const extension = path.extname(filePath).toLowerCase();
	return LANGUAGE_ADAPTERS.find((adapter) => adapter.extensions.includes(extension));
}

export async function findLanguageWorkspaceRoot(
	filePath: string,
	projectRoot: string,
	adapter: LanguageAdapter,
): Promise<string> {
	const resolvedProject = path.resolve(projectRoot);
	const resolvedFile = path.resolve(filePath);
	const relative = path.relative(resolvedProject, resolvedFile);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("LSP 只能读取当前项目中的文件。");
	}

	let directory = path.dirname(resolvedFile);
	while (true) {
		for (const marker of adapter.rootMarkers) {
			try {
				await access(path.join(directory, marker), constants.F_OK);
				return directory;
			} catch {
				// Try the next marker or parent directory.
			}
		}
		if (directory === resolvedProject) return resolvedProject;
		const parent = path.dirname(directory);
		if (parent === directory || !path.relative(resolvedProject, parent).startsWith("..")) directory = parent;
		else return resolvedProject;
	}
}

export function formatLanguageServerSetup(adapter: LanguageAdapter): string {
	switch (adapter.id) {
		case "typescript":
			return isBunBinary
				? "独立二进制需要外部 TypeScript 语言服务器：npm install -g typescript-language-server typescript"
				: "TypeScript/JavaScript 语言服务器已随 Pi 安装，可以直接使用。";
		case "python":
			return "未找到 Python 语言服务器。请在项目环境运行：pip install basedpyright";
		case "go":
			return "未找到 Go 语言服务器。请运行：go install golang.org/x/tools/gopls@latest";
	}
}

export function formatLanguageServerStartup(adapter: LanguageAdapter): string {
	switch (adapter.id) {
		case "typescript":
			return "正在启动 TypeScript/JavaScript 语言服务器；第一次通常需要几秒。";
		case "python":
			return "正在启动 Python 语言服务器。若尚未安装，请在项目环境运行：pip install basedpyright";
		case "go":
			return "正在启动 Go 语言服务器。若尚未安装，请运行：go install golang.org/x/tools/gopls@latest";
	}
}
