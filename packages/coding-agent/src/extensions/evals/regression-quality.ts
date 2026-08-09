import { builtinModules } from "node:module";
import path from "node:path";
import type {
	RegressionDraftQuality,
	RegressionQualityIssue,
	RegressionTestDraft,
	RegressionTestFramework,
} from "./types.ts";

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const TEST_MODULES = new Set(["vitest", "node:test", "node:assert", "assert", "@jest/globals", "jest"]);
const PYTHON_NON_PRODUCT_MODULES = new Set([
	"pytest",
	"unittest",
	"os",
	"sys",
	"pathlib",
	"subprocess",
	"tempfile",
	"json",
	"typing",
]);
const GO_NON_PRODUCT_CALLS = new Set([
	"Test",
	"Benchmark",
	"Example",
	"make",
	"len",
	"cap",
	"append",
	"copy",
	"delete",
	"new",
	"panic",
	"recover",
	"print",
	"println",
	"Error",
	"Errorf",
	"Fatal",
	"Fatalf",
	"Fail",
	"FailNow",
]);

function matches(source: string, pattern: RegExp): number {
	return [...source.matchAll(pattern)].length;
}

function javascriptSpecifiers(source: string): string[] {
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*["']([^"']+)["']/g,
		/\b(?:require|import)\s*\(\s*["']([^"']+)["']/g,
	];
	return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ""));
}

function testOnlySpecifier(specifier: string): boolean {
	const normalized = specifier.replaceAll("\\", "/").toLowerCase();
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.includes("/test/") ||
		normalized.includes("/tests/") ||
		normalized.includes("fixture") ||
		normalized.includes("mock") ||
		basename.includes(".test.") ||
		basename.includes(".spec.")
	);
}

function javascriptProductReferences(source: string): string[] {
	const imports = javascriptSpecifiers(source).filter(
		(specifier) =>
			specifier.length > 0 &&
			!TEST_MODULES.has(specifier) &&
			!NODE_BUILTINS.has(specifier) &&
			!testOnlySpecifier(specifier),
	);
	const cliReferences = [...source.matchAll(/["'`]([^"'`]*(?:src|dist)[/\\]cli\.[cm]?[jt]s)["'`]/g)].map(
		(match) => match[1] ?? "",
	);
	return [...new Set([...imports, ...cliReferences])].slice(0, 6);
}

function pythonProductReferences(source: string): string[] {
	const modules = [...source.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)].map((match) => match[1] ?? "");
	const cliReferences = [...source.matchAll(/["']([^"']*(?:src|dist)[/\\]cli\.py)["']/g)].map(
		(match) => match[1] ?? "",
	);
	return [
		...new Set([
			...modules.filter((moduleName) => !PYTHON_NON_PRODUCT_MODULES.has(moduleName.split(".")[0] ?? moduleName)),
			...cliReferences,
		]),
	].slice(0, 6);
}

function goProductReferences(source: string): string[] {
	const declared = new Set(
		[...source.matchAll(/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]),
	);
	const calls = [...source.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1] ?? "");
	return [
		...new Set(
			calls.filter(
				(name) =>
					name.length > 0 &&
					!declared.has(name) &&
					!GO_NON_PRODUCT_CALLS.has(name) &&
					!name.startsWith("Test") &&
					!name.startsWith("Benchmark"),
			),
		),
	].slice(0, 6);
}

function detectFramework(draft: RegressionTestDraft, source: string): RegressionTestFramework | undefined {
	const extensions = new Set(draft.files.map((file) => path.extname(file.path).toLowerCase()));
	if ([...extensions].every((extension) => extension === ".py")) return "pytest";
	if (
		[...extensions].every((extension) => extension === ".go") &&
		draft.files.every((file) => file.path.endsWith("_test.go"))
	) {
		return /["']testing["']/.test(source) ? "go test" : undefined;
	}
	if (/(?:from\s+|require\()\s*["']vitest["']/.test(source)) return "vitest";
	if (/(?:from\s+|require\()\s*["']node:test["']/.test(source)) return "node:test";
	return undefined;
}

function assertionCount(framework: RegressionTestFramework | undefined, source: string): number {
	if (framework === "pytest") return matches(source, /\bassert\s+|pytest\.raises\s*\(/g);
	if (framework === "go test") {
		return matches(source, /\b(?:t\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)|require\.\w+|assert\.\w+)\s*\(/g);
	}
	return matches(source, /\b(?:expect|assert(?:\.\w+)?)\s*\(/g);
}

export function assessRegressionDraftQuality(draft: RegressionTestDraft): RegressionDraftQuality {
	const source = draft.files.map((file) => file.content).join("\n");
	const framework = detectFramework(draft, source);
	const assertions = assertionCount(framework, source);
	const references =
		framework === "pytest"
			? pythonProductReferences(source)
			: framework === "go test"
				? goProductReferences(source)
				: javascriptProductReferences(source);
	const issues: RegressionQualityIssue[] = [];
	if (!framework) issues.push("missing_framework");
	if (assertions === 0) issues.push("missing_assertion");
	if (references.length === 0) issues.push("missing_product_reference");
	if (!framework || issues.length > 0) return { passed: false, issues };
	return {
		passed: true,
		issues: [],
		evidence: {
			version: 1,
			framework,
			assertionCount: assertions,
			productReferences: references,
		},
	};
}
