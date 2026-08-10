import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPluginManifest } from "../src/core/plugins/manifest.ts";

function sha256(content: string): string {
	return `sha256-${createHash("sha256").update(content).digest("base64")}`;
}

function createPlugin(overrides: Record<string, unknown> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "pi-plugin-manifest-"));
	mkdirSync(join(root, "extensions"), { recursive: true });
	mkdirSync(join(root, "skills", "review"), { recursive: true });
	mkdirSync(join(root, "mcp"), { recursive: true });
	mkdirSync(join(root, "resources"), { recursive: true });
	const files = {
		"extensions/index.ts": "export default () => {};\n",
		"skills/review/SKILL.md": "# Review\n",
		"mcp/server.json": '{"servers":{}}\n',
		"resources/guide.md": "# Guide\n",
	};
	for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content, "utf8");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "safe-plugin", version: "1.2.3" }), "utf8");
	writeFileSync(
		join(root, "pi-plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "safe-plugin",
			version: "1.2.3",
			minimumPiVersion: ">=0.84.0",
			capabilities: {
				extensions: ["extensions/index.ts"],
				skills: ["skills/review/SKILL.md"],
				mcp: ["mcp/server.json"],
				resources: ["resources/guide.md"],
			},
			integrity: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)])),
			...overrides,
		}),
		"utf8",
	);
	return root;
}

describe("controlled plugin manifest", () => {
	it("verifies declared capabilities, host version, and file hashes", () => {
		const result = inspectPluginManifest(createPlugin(), "0.84.1");
		expect(result.manifest.id).toBe("safe-plugin");
		expect(result.fingerprint).toMatch(/^sha256-[A-Za-z0-9+/=]+$/);
		expect(result.files).toHaveLength(4);
		expect(result.files.every((file) => file.absolutePath.startsWith(result.root))).toBe(true);
	});

	it("rejects traversal and undeclared lifecycle behavior", () => {
		const root = createPlugin({
			capabilities: { extensions: ["../escape.ts"] },
			integrity: { "../escape.ts": sha256("escape") },
		});
		expect(() => inspectPluginManifest(root, "0.84.1")).toThrow(/relative path|outside/i);

		const scripted = createPlugin();
		writeFileSync(
			join(scripted, "package.json"),
			JSON.stringify({ name: "safe-plugin", version: "1.2.3", scripts: { postinstall: "node setup.js" } }),
			"utf8",
		);
		expect(() => inspectPluginManifest(scripted, "0.84.1")).toThrow(/postinstall/);
	});

	it("rejects stale hashes and incompatible host versions", () => {
		const root = createPlugin();
		writeFileSync(join(root, "resources", "guide.md"), "changed\n", "utf8");
		expect(() => inspectPluginManifest(root, "0.84.1")).toThrow(/integrity/i);
		expect(() => inspectPluginManifest(createPlugin(), "0.83.9")).toThrow(/requires pi/i);
	});
});
