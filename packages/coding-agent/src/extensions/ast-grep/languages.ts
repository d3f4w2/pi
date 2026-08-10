import path from "node:path";
import goRegistration from "@ast-grep/lang-go";
import jsonRegistration from "@ast-grep/lang-json";
import pythonRegistration from "@ast-grep/lang-python";
import rustRegistration from "@ast-grep/lang-rust";
import yamlRegistration from "@ast-grep/lang-yaml";
import { Lang, type parseAsync, registerDynamicLanguage } from "@ast-grep/napi";
import { parseDocument } from "yaml";
import type { AstGrepExplicitLanguage, AstGrepLanguage } from "./types.ts";

type NapiLanguage = Parameters<typeof parseAsync>[0];

export interface LanguageConfig {
	id: AstGrepExplicitLanguage;
	engine: "napi" | "markdown";
	lang?: NapiLanguage;
	globs: string[];
	extensions: string[];
	validate?(source: string): void;
}

const REGISTRATION_STATE = Symbol.for("pi-go.ast-grep.dynamic-languages.v1");

function ensureDynamicLanguages(): void {
	const current = Reflect.get(globalThis, REGISTRATION_STATE);
	if (current === true) return;
	if (current instanceof Error) throw current;
	try {
		registerDynamicLanguage({
			python: pythonRegistration,
			go: goRegistration,
			rust: rustRegistration,
			json: jsonRegistration,
			yaml: yamlRegistration,
		});
		Reflect.set(globalThis, REGISTRATION_STATE, true);
	} catch (error) {
		const failure = new Error(
			`AST 动态语言解析器注册失败：${error instanceof Error ? error.message : String(error)}`,
		);
		Reflect.set(globalThis, REGISTRATION_STATE, failure);
		throw failure;
	}
}

function validateJson(source: string): void {
	try {
		JSON.parse(source);
	} catch (error) {
		throw new Error(
			`ast_edit 生成了无效 JSON，未写入任何文件：${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function validateYaml(source: string): void {
	const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new Error(`ast_edit 生成了无效 YAML，未写入任何文件：${document.errors[0]?.message ?? "解析失败"}`);
	}
}

const LANGUAGE_CONFIGS: Readonly<Record<AstGrepExplicitLanguage, LanguageConfig>> = {
	javascript: {
		id: "javascript",
		engine: "napi",
		lang: Lang.JavaScript,
		globs: ["**/*.{js,jsx,mjs,cjs}"],
		extensions: [".js", ".jsx", ".mjs", ".cjs"],
	},
	typescript: {
		id: "typescript",
		engine: "napi",
		lang: Lang.TypeScript,
		globs: ["**/*.{ts,mts,cts}"],
		extensions: [".ts", ".mts", ".cts"],
	},
	tsx: { id: "tsx", engine: "napi", lang: Lang.Tsx, globs: ["**/*.tsx"], extensions: [".tsx"] },
	html: {
		id: "html",
		engine: "napi",
		lang: Lang.Html,
		globs: ["**/*.{html,htm}"],
		extensions: [".html", ".htm"],
	},
	css: { id: "css", engine: "napi", lang: Lang.Css, globs: ["**/*.css"], extensions: [".css"] },
	python: { id: "python", engine: "napi", lang: "python", globs: ["**/*.{py,pyi}"], extensions: [".py", ".pyi"] },
	go: { id: "go", engine: "napi", lang: "go", globs: ["**/*.go"], extensions: [".go"] },
	rust: { id: "rust", engine: "napi", lang: "rust", globs: ["**/*.rs"], extensions: [".rs"] },
	json: {
		id: "json",
		engine: "napi",
		lang: "json",
		globs: ["**/*.json"],
		extensions: [".json"],
		validate: validateJson,
	},
	yaml: {
		id: "yaml",
		engine: "napi",
		lang: "yaml",
		globs: ["**/*.{yaml,yml}"],
		extensions: [".yaml", ".yml"],
		validate: validateYaml,
	},
	markdown: {
		id: "markdown",
		engine: "markdown",
		globs: ["**/*.{md,markdown,mdown,mkdn}"],
		extensions: [".md", ".markdown", ".mdown", ".mkdn"],
	},
};

export const ALL_LANGUAGE_CONFIGS = Object.values(LANGUAGE_CONFIGS);

export function configForFile(filePath: string, language: AstGrepLanguage): LanguageConfig | undefined {
	const config =
		language === "auto"
			? ALL_LANGUAGE_CONFIGS.find((candidate) => candidate.extensions.includes(path.extname(filePath).toLowerCase()))
			: LANGUAGE_CONFIGS[language];
	if (
		config?.engine === "napi" &&
		typeof config.lang === "string" &&
		!Object.values(Lang).includes(config.lang as Lang)
	) {
		ensureDynamicLanguages();
	}
	return config;
}

export function languageConfig(language: AstGrepExplicitLanguage): LanguageConfig {
	return (
		configForFile(`file${LANGUAGE_CONFIGS[language].extensions[0] ?? ""}`, language) ?? LANGUAGE_CONFIGS[language]
	);
}

export function supportedLanguageMessage(): string {
	return ALL_LANGUAGE_CONFIGS.map((config) => config.id).join(", ");
}

export function captureNames(pattern: string): string[] {
	return [
		...new Set(
			[...pattern.matchAll(/\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g)]
				.map((match) => match[1] ?? match[2])
				.filter((name): name is string => !!name),
		),
	];
}
