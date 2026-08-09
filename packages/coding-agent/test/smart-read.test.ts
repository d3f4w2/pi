import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-smart-read-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function textFrom(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function createTypeScriptSource(methodCount = 48): string {
	const methods = Array.from(
		{ length: methodCount },
		(_, index) => `  method${index}(value: number): number {
    const adjusted = value + ${index};
    const doubled = adjusted * 2;
    return doubled;
  }`,
	).join("\n\n");
	const tailBody = Array.from({ length: 16 }, (_, index) => `  const step${index} = input + "${index}";`).join("\n");
	return `import { readFile } from "node:fs/promises";

export interface StoreOptions {
  root: string;
  retries: number;
}

export class BigStore {
${methods}
}

export function tailOperation(input: string): string {
${tailBody}
  return step15.toUpperCase();
}
`;
}

function createPythonSource(functionCount = 45): string {
	const functions = Array.from(
		{ length: functionCount },
		(_, index) => `def handler_${index}(value: int) -> int:
    adjusted = value + ${index}
    doubled = adjusted * 2
    return doubled`,
	).join("\n\n");
	return `from pathlib import Path\n\n${functions}\n`;
}

function createGoSource(functionCount = 45): string {
	const functions = Array.from(
		{ length: functionCount },
		(_, index) => `func Handler${index}(value int) int {
    adjusted := value + ${index}
    doubled := adjusted * 2
    return doubled
}`,
	).join("\n\n");
	return `package sample\n\nimport "fmt"\n\ntype Store struct {\n    Name string\n}\n\n${functions}\n`;
}

async function runRead(
	dir: string,
	input: { path: string; offset?: number; limit?: number; mode?: "auto" | "full" | "outline" },
	options?: Parameters<typeof createReadToolDefinition>[1],
) {
	return createReadToolDefinition(dir, options).execute("read", input, undefined, undefined, {} as ExtensionContext);
}

describe("smart read", () => {
	it("automatically outlines long TypeScript files across the whole file", async () => {
		const dir = await createTempDir();
		const source = createTypeScriptSource();
		await writeFile(join(dir, "store.ts"), source, "utf8");

		const result = await runRead(dir, { path: "store.ts" });
		const output = textFrom(result);

		expect(output).toContain("[Outline:");
		expect(output).toContain("export interface StoreOptions");
		expect(output).toContain("method20(value: number): number");
		expect(output).toContain("export function tailOperation");
		expect(output).not.toContain("const adjusted = value + 20");
		expect(output).toMatch(/\[\.\.\. lines \d+-\d+ omitted; use offset=\d+ limit=\d+ \.\.\.\]/);
		expect(output.length).toBeLessThan(source.length * 0.6);
		expect(result.details?.outline).toMatchObject({ strategy: "ast", totalLines: source.split("\n").length });
	});

	it("returns verbatim content when full mode is explicit", async () => {
		const dir = await createTempDir();
		const source = createTypeScriptSource();
		await writeFile(join(dir, "store.ts"), source, "utf8");

		const output = textFrom(await runRead(dir, { path: "store.ts", mode: "full" }));
		expect(output).not.toContain("[Outline:");
		expect(output).toContain("const adjusted = value + 20");
	});

	it("treats offset and limit as an exact focused read", async () => {
		const dir = await createTempDir();
		const source = createTypeScriptSource();
		await writeFile(join(dir, "store.ts"), source, "utf8");
		const lines = source.split("\n");
		const targetLine = lines.findIndex((line) => line.includes("const adjusted = value + 20")) + 1;

		const output = textFrom(await runRead(dir, { path: "store.ts", offset: targetLine, limit: 3 }));
		expect(output).not.toContain("[Outline:");
		expect(output).toContain(`${targetLine}#`);
		expect(output).toContain("const adjusted = value + 20");
		expect(output).not.toContain("tailOperation");
	});

	it("keeps short files verbatim in auto mode and allows a forced outline", async () => {
		const dir = await createTempDir();
		const source = createTypeScriptSource(5);
		await writeFile(join(dir, "short.ts"), source, "utf8");

		const automatic = textFrom(await runRead(dir, { path: "short.ts" }));
		const forced = textFrom(await runRead(dir, { path: "short.ts", mode: "outline" }));
		expect(automatic).not.toContain("[Outline:");
		expect(automatic).toContain("const adjusted = value + 2");
		expect(forced).toContain("[Outline:");
		expect(forced).not.toContain("const adjusted = value + 2");
	});

	it("extracts declarations from long Python and Go files", async () => {
		const dir = await createTempDir();
		const python = createPythonSource();
		const go = createGoSource();
		await writeFile(join(dir, "handlers.py"), python, "utf8");
		await writeFile(join(dir, "handlers.go"), go, "utf8");

		const pythonResult = await runRead(dir, { path: "handlers.py" });
		const goResult = await runRead(dir, { path: "handlers.go" });
		const pythonOutput = textFrom(pythonResult);
		const goOutput = textFrom(goResult);

		expect(pythonOutput).toContain("def handler_40(value: int) -> int:");
		expect(pythonOutput).not.toContain("adjusted = value + 40");
		expect(pythonResult.details?.outline?.strategy).toBe("lexical");
		expect(goOutput).toContain("func Handler40(value int) int {");
		expect(goOutput).not.toContain("adjusted := value + 40");
		expect(goResult.details?.outline?.strategy).toBe("lexical");
	});

	it("samples oversized declaration sets across the whole file", async () => {
		const dir = await createTempDir();
		const source = Array.from(
			{ length: 220 },
			(_, index) => `export function operation${index}(): number {\n  return ${index};\n}`,
		).join("\n\n");
		await writeFile(join(dir, "operations.ts"), source, "utf8");

		const result = await runRead(dir, { path: "operations.ts" });
		const output = textFrom(result);
		expect(output).toContain("operation0(): number");
		expect(output).toContain("operation219(): number");
		expect(result.details?.outline?.shownLines).toBeLessThanOrEqual(120);
		expect(output).not.toContain("return 219");
	});

	it("reuses structural plans by content revision", async () => {
		const dir = await createTempDir();
		const source = `${createTypeScriptSource(37)}\n// unique cache case`;
		await writeFile(join(dir, "cached.ts"), source, "utf8");

		const first = await runRead(dir, { path: "cached.ts" });
		const second = await runRead(dir, { path: "cached.ts" });
		expect(first.details?.outline?.cacheHit).toBe(false);
		expect(second.details?.outline?.cacheHit).toBe(true);
		expect(textFrom(second)).toBe(textFrom(first));
	});

	it("uses verbatim auto mode when an outline would not meaningfully reduce output", async () => {
		const dir = await createTempDir();
		const source = Array.from({ length: 220 }, (_, index) => `export const item${index} = ${index};`).join("\n");
		await writeFile(join(dir, "constants.ts"), source, "utf8");

		const automatic = textFrom(await runRead(dir, { path: "constants.ts" }));
		const forced = textFrom(await runRead(dir, { path: "constants.ts", mode: "outline" }));
		expect(automatic).not.toContain("[Outline:");
		expect(automatic).toContain("export const item100 = 100;");
		expect(forced).toContain("[Outline:");
	});

	it("bounds very long outline lines while keeping their source anchor", async () => {
		const dir = await createTempDir();
		const longValue = "x".repeat(4_000);
		const source = Array.from(
			{ length: 180 },
			(_, index) => `export const item${index} = "${longValue}${index}";`,
		).join("\n");
		await writeFile(join(dir, "generated.ts"), source, "utf8");

		const output = textFrom(await runRead(dir, { path: "generated.ts", mode: "outline" }));
		expect(output).toContain("[truncated; use offset=");
		expect(output.length).toBeLessThan(80_000);
		expect(output).toMatch(/\d+#[A-Za-z0-9_-]{6}\|export const item/);
	});

	it("keeps unsupported text and instruction resources verbatim", async () => {
		const dir = await createTempDir();
		const content = Array.from({ length: 220 }, (_, index) => `plain line ${index + 1}`).join("\n");
		await writeFile(join(dir, "notes.txt"), content, "utf8");
		await writeFile(join(dir, "AGENTS.md"), content, "utf8");

		const plainOutput = textFrom(await runRead(dir, { path: "notes.txt" }));
		const resourceOutput = textFrom(await runRead(dir, { path: "AGENTS.md", mode: "outline" }));
		expect(plainOutput).not.toContain("[Outline:");
		expect(plainOutput).toContain("plain line 200");
		expect(resourceOutput).toBe(content);
	});

	it("falls back to verbatim content when the outline service fails", async () => {
		const dir = await createTempDir();
		const source = createTypeScriptSource();
		await writeFile(join(dir, "store.ts"), source, "utf8");

		const output = textFrom(
			await runRead(
				dir,
				{ path: "store.ts" },
				{
					outlineService: {
						createOutline: async () => {
							throw new Error("parser unavailable");
						},
					},
				},
			),
		);
		expect(output).not.toContain("[Outline:");
		expect(output).toContain("const adjusted = value + 20");
	});
});
