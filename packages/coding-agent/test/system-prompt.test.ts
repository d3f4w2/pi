import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
					grep: "Search file contents",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
			expect(prompt).toContain("- grep:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});

		test("uses focused reads for exploration and expands only when evidence is incomplete", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("For exploratory pi questions, use available search tools");
			expect(prompt).toContain("expand only when the evidence is incomplete");
			expect(prompt).not.toContain("Always read pi .md files completely");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("does not replace a disabled grep tool with shell rg", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Exact file-content search is unavailable until the grep tool is enabled");
			expect(prompt).toContain("Do not emulate it through bash");
			expect(prompt).not.toContain("Use bash for file operations like ls, rg, find");
		});

		test("uses built-in grep directly instead of running rg through bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash", "grep"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Every exact file-content search must use the grep tool directly");
			expect(prompt).toContain("Call grep once per path when searching multiple directories");
			expect(prompt).toContain("Never run rg, grep, findstr, or Select-String through bash");
		});

		test("does not advertise bash as a file-content search tool", () => {
			const bash = createBashToolDefinition(process.cwd());
			const grep = createGrepToolDefinition(process.cwd());

			expect(bash.promptSnippet).not.toMatch(/grep|rg/i);
			expect(grep.promptSnippet).toContain("instead of shell rg or grep");
			expect(grep.promptGuidelines?.join(" ")).toContain("call grep once for each path");
		});

		test("routes Windows-only operations through the PowerShell executor", () => {
			const bash = createBashToolDefinition(process.cwd());
			const guidance = bash.promptGuidelines?.join(" ") ?? "";

			if (process.platform === "win32") {
				expect(guidance).toContain('executor="powershell"');
				expect(guidance).toContain("Windows-only");
				expect(guidance).toContain("Git, npm, Node, or Python");
			} else {
				expect(guidance).not.toContain('executor="powershell"');
			}
		});

		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
