import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { glob, globIterate } from "glob";
import * as ts from "typescript";

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TESTS = 20;
const READ_BATCH_SIZE = 32;
const IGNORED_PATHS = [
	"**/node_modules/**",
	"**/.git/**",
	"**/dist/**",
	"**/build/**",
	"**/coverage/**",
	"**/.venv/**",
	"**/venv/**",
];
const TEST_FILE_PATTERN = /(?:^|[._-])(test|spec)(?:[._-]|$)/i;

export interface ImpactAnalysisOptions {
	maxFiles?: number;
	maxFileBytes?: number;
	maxTests?: number;
}

export interface RelatedTestsResult {
	files: string[];
	strategy: "target-test" | "dependency-graph" | "filename-fallback" | "none";
	truncated: boolean;
	note?: string;
}

interface SourceFile {
	absolutePath: string;
	relativePath: string;
	content: string;
}

interface SourceCollection {
	files: SourceFile[];
	limitExceeded: boolean;
	skippedLargeFiles: number;
}

function normalizedAbsolute(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function portableRelative(root: string, filePath: string): string {
	return path.relative(root, filePath).replaceAll("\\", "/");
}

function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(normalizedAbsolute(root), normalizedAbsolute(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isVerifyTestFile(filePath: string): boolean {
	return TEST_FILE_PATTERN.test(path.basename(filePath)) || /(^|[/\\])(test|tests|__tests__)([/\\]|$)/i.test(filePath);
}

function testStem(filePath: string): string {
	return path
		.basename(filePath)
		.replace(/\.(test|spec)$/i, "")
		.replace(/\.[^.]+$/, "");
}

async function filenameMatches(
	workspaceRoot: string,
	targetPath: string,
	patterns: (stem: string) => string[],
	maxTests: number,
): Promise<string[]> {
	const stem = testStem(targetPath);
	return (await glob(patterns(stem), { cwd: workspaceRoot, nodir: true, ignore: IGNORED_PATHS }))
		.map((filePath) => filePath.replaceAll("\\", "/"))
		.sort()
		.slice(0, maxTests);
}

async function collectSources(
	workspaceRoot: string,
	patterns: string[],
	options: Required<ImpactAnalysisOptions>,
): Promise<SourceCollection> {
	const relativePaths: string[] = [];
	for await (const filePath of globIterate(patterns, {
		cwd: workspaceRoot,
		nodir: true,
		ignore: IGNORED_PATHS,
	})) {
		relativePaths.push(filePath.replaceAll("\\", "/"));
		if (relativePaths.length > options.maxFiles) {
			return { files: [], limitExceeded: true, skippedLargeFiles: 0 };
		}
	}

	relativePaths.sort();
	const files: SourceFile[] = [];
	let skippedLargeFiles = 0;
	for (let offset = 0; offset < relativePaths.length; offset += READ_BATCH_SIZE) {
		const batch = relativePaths.slice(offset, offset + READ_BATCH_SIZE);
		const results = await Promise.all(
			batch.map(async (relativePath): Promise<SourceFile | undefined> => {
				const absolutePath = path.resolve(workspaceRoot, relativePath);
				try {
					const fileStat = await stat(absolutePath);
					if (fileStat.size > options.maxFileBytes) return undefined;
					return { absolutePath, relativePath, content: await readFile(absolutePath, "utf8") };
				} catch {
					return undefined;
				}
			}),
		);
		for (const result of results) {
			if (result) files.push(result);
			else skippedLargeFiles++;
		}
	}
	return { files, limitExceeded: false, skippedLargeFiles };
}

function relatedFromReverseGraph(
	targetPath: string,
	filesByPath: ReadonlyMap<string, SourceFile>,
	reverseGraph: ReadonlyMap<string, ReadonlySet<string>>,
	maxTests: number,
): { files: string[]; truncated: boolean } {
	const target = normalizedAbsolute(targetPath);
	const distances = new Map<string, number>([[target, 0]]);
	const queue = [target];
	for (let index = 0; index < queue.length; index++) {
		const dependency = queue[index];
		if (!dependency) continue;
		const distance = distances.get(dependency) ?? 0;
		for (const importer of reverseGraph.get(dependency) ?? []) {
			if (distances.has(importer)) continue;
			distances.set(importer, distance + 1);
			queue.push(importer);
		}
	}

	const related = [...distances.entries()]
		.filter(([filePath, distance]) => distance > 0 && isVerifyTestFile(filesByPath.get(filePath)?.relativePath ?? ""))
		.sort(([leftPath, leftDistance], [rightPath, rightDistance]) => {
			if (leftDistance !== rightDistance) return leftDistance - rightDistance;
			return (filesByPath.get(leftPath)?.relativePath ?? leftPath).localeCompare(
				filesByPath.get(rightPath)?.relativePath ?? rightPath,
			);
		})
		.map(([filePath]) => filesByPath.get(filePath)?.relativePath)
		.filter((filePath): filePath is string => filePath !== undefined);
	return { files: related.slice(0, maxTests), truncated: related.length > maxTests };
}

function mergeRelatedTests(graphFiles: string[], filenameFiles: string[], maxTests: number): string[] {
	return [...new Set([...graphFiles, ...filenameFiles])].slice(0, maxTests);
}

function analysisOptions(options: ImpactAnalysisOptions): Required<ImpactAnalysisOptions> {
	return {
		maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES),
		maxFileBytes: Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
		maxTests: Math.max(1, options.maxTests ?? DEFAULT_MAX_TESTS),
	};
}

function findTsConfig(targetPath: string, workspaceRoot: string): string | undefined {
	let directory = path.dirname(targetPath);
	while (isPathInside(workspaceRoot, directory)) {
		for (const name of ["tsconfig.json", "jsconfig.json"]) {
			const candidate = path.join(directory, name);
			if (ts.sys.fileExists(candidate)) return candidate;
		}
		if (normalizedAbsolute(directory) === normalizedAbsolute(workspaceRoot)) break;
		directory = path.dirname(directory);
	}
	return undefined;
}

function compilerOptions(targetPath: string, workspaceRoot: string): ts.CompilerOptions {
	const defaults: ts.CompilerOptions = {
		allowJs: true,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
	};
	const configPath = findTsConfig(targetPath, workspaceRoot);
	if (!configPath) return defaults;
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error || typeof config.config !== "object" || config.config === null) return defaults;
	const configuredOptions = Reflect.get(config.config, "compilerOptions");
	if (typeof configuredOptions !== "object" || configuredOptions === null) return defaults;
	const converted = ts.convertCompilerOptionsFromJson(configuredOptions, path.dirname(configPath), configPath);
	return { ...defaults, ...converted.options };
}

export async function findJavaScriptRelatedTests(
	workspaceRoot: string,
	targetPath: string,
	options: ImpactAnalysisOptions = {},
): Promise<RelatedTestsResult> {
	const limits = analysisOptions(options);
	const relativeTarget = portableRelative(workspaceRoot, targetPath);
	if (isVerifyTestFile(relativeTarget)) {
		return { files: [relativeTarget], strategy: "target-test", truncated: false };
	}
	const fallback = await filenameMatches(
		workspaceRoot,
		targetPath,
		(stem) => [`**/${stem}.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`, `**/${stem}-test.{ts,tsx,js,jsx}`],
		limits.maxTests,
	);
	const collection = await collectSources(workspaceRoot, ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], limits);
	if (collection.limitExceeded) {
		return {
			files: fallback,
			strategy: fallback.length > 0 ? "filename-fallback" : "none",
			truncated: true,
			note: `依赖分析超过 ${limits.maxFiles} 个文件，已立即停止并仅按文件名寻找测试。`,
		};
	}

	const filesByPath = new Map(collection.files.map((file) => [normalizedAbsolute(file.absolutePath), file]));
	const reverseGraph = new Map<string, Set<string>>();
	const optionsForResolution = compilerOptions(targetPath, workspaceRoot);
	const resolutionCache = ts.createModuleResolutionCache(
		workspaceRoot,
		(fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
		optionsForResolution,
	);
	for (const file of collection.files) {
		const importer = normalizedAbsolute(file.absolutePath);
		for (const imported of ts.preProcessFile(file.content, true, true).importedFiles) {
			const resolved = ts.resolveModuleName(
				imported.fileName,
				file.absolutePath,
				optionsForResolution,
				ts.sys,
				resolutionCache,
				undefined,
				imported.resolutionMode,
			).resolvedModule;
			if (!resolved || resolved.isExternalLibraryImport || !isPathInside(workspaceRoot, resolved.resolvedFileName)) {
				continue;
			}
			const dependency = normalizedAbsolute(resolved.resolvedFileName);
			if (!filesByPath.has(dependency)) continue;
			const importers = reverseGraph.get(dependency) ?? new Set<string>();
			importers.add(importer);
			reverseGraph.set(dependency, importers);
		}
	}

	const graph = relatedFromReverseGraph(targetPath, filesByPath, reverseGraph, limits.maxTests);
	const files = mergeRelatedTests(graph.files, fallback, limits.maxTests);
	const truncated = graph.truncated || collection.skippedLargeFiles > 0;
	return {
		files,
		strategy: graph.files.length > 0 ? "dependency-graph" : files.length > 0 ? "filename-fallback" : "none",
		truncated,
		...(collection.skippedLargeFiles > 0
			? { note: `${collection.skippedLargeFiles} 个超大或无法读取的文件未参与依赖分析。` }
			: {}),
	};
}

function pythonModuleAliases(relativePath: string): string[] {
	const withoutExtension = relativePath.replace(/\.pyi?$/, "").replaceAll("/", ".");
	const withoutInit = withoutExtension.endsWith(".__init__") ? withoutExtension.slice(0, -9) : withoutExtension;
	const aliases = new Set([withoutInit]);
	if (withoutInit.startsWith("src.")) aliases.add(withoutInit.slice(4));
	return [...aliases].filter(Boolean);
}

function pythonImports(content: string): string[] {
	const imports = new Set<string>();
	for (const line of content.split(/\r?\n/)) {
		const fromMatch = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(line);
		if (fromMatch?.[1]) {
			imports.add(fromMatch[1]);
			for (const importedName of fromMatch[2]?.split(",") ?? []) {
				const name = importedName.trim().split(/\s+as\s+/)[0];
				if (name && name !== "*" && !name.includes("(")) imports.add(`${fromMatch[1]}.${name}`);
			}
			continue;
		}
		const importMatch = /^\s*import\s+(.+)$/.exec(line);
		for (const importedName of importMatch?.[1]?.split(",") ?? []) {
			const name = importedName.trim().split(/\s+as\s+/)[0];
			if (name) imports.add(name);
		}
	}
	return [...imports];
}

function resolvePythonImport(
	importer: SourceFile,
	importedName: string,
	modules: ReadonlyMap<string, string>,
): string[] {
	if (!importedName.startsWith(".")) {
		const exact = modules.get(importedName);
		return exact ? [exact] : [];
	}
	const dots = importedName.length - importedName.replace(/^\.+/, "").length;
	const remainder = importedName.slice(dots);
	const importerAliases = pythonModuleAliases(importer.relativePath);
	const importerModule = importerAliases.find((alias) => !alias.startsWith("src.")) ?? importerAliases[0] ?? "";
	const packageParts = importerModule.split(".").slice(0, -1);
	const baseParts = packageParts.slice(0, Math.max(0, packageParts.length - (dots - 1)));
	const absoluteName = [...baseParts, ...remainder.split(".").filter(Boolean)].join(".");
	const resolved = modules.get(absoluteName);
	return resolved ? [resolved] : [];
}

export async function findPythonRelatedTests(
	workspaceRoot: string,
	targetPath: string,
	options: ImpactAnalysisOptions = {},
): Promise<RelatedTestsResult> {
	const limits = analysisOptions(options);
	const relativeTarget = portableRelative(workspaceRoot, targetPath);
	if (isVerifyTestFile(relativeTarget)) {
		return { files: [relativeTarget], strategy: "target-test", truncated: false };
	}
	const fallback = await filenameMatches(
		workspaceRoot,
		targetPath,
		(stem) => [`**/test_${stem}.py`, `**/${stem}_test.py`],
		limits.maxTests,
	);
	const collection = await collectSources(workspaceRoot, ["**/*.{py,pyi}"], limits);
	if (collection.limitExceeded) {
		return {
			files: fallback,
			strategy: fallback.length > 0 ? "filename-fallback" : "none",
			truncated: true,
			note: `依赖分析超过 ${limits.maxFiles} 个文件，已立即停止并仅按文件名寻找测试。`,
		};
	}

	const filesByPath = new Map(collection.files.map((file) => [normalizedAbsolute(file.absolutePath), file]));
	const modules = new Map<string, string>();
	for (const file of collection.files) {
		for (const alias of pythonModuleAliases(file.relativePath))
			modules.set(alias, normalizedAbsolute(file.absolutePath));
	}
	const reverseGraph = new Map<string, Set<string>>();
	for (const file of collection.files) {
		const importer = normalizedAbsolute(file.absolutePath);
		for (const importedName of pythonImports(file.content)) {
			for (const dependency of resolvePythonImport(file, importedName, modules)) {
				const importers = reverseGraph.get(dependency) ?? new Set<string>();
				importers.add(importer);
				reverseGraph.set(dependency, importers);
			}
		}
	}

	const graph = relatedFromReverseGraph(targetPath, filesByPath, reverseGraph, limits.maxTests);
	const files = mergeRelatedTests(graph.files, fallback, limits.maxTests);
	const truncated = graph.truncated || collection.skippedLargeFiles > 0;
	return {
		files,
		strategy: graph.files.length > 0 ? "dependency-graph" : files.length > 0 ? "filename-fallback" : "none",
		truncated,
		...(collection.skippedLargeFiles > 0
			? { note: `${collection.skippedLargeFiles} 个超大或无法读取的文件未参与依赖分析。` }
			: {}),
	};
}
