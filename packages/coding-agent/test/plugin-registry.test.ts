import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { PluginRegistry } from "../src/core/plugins/registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function createPlugin(base: string, content = "export default () => {};\n"): string {
	const root = join(base, "plugin");
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions", "index.ts"), content, "utf8");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "registry-plugin", version: "1.0.0" }), "utf8");
	writeFileSync(
		join(root, "pi-plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "registry-plugin",
			version: "1.0.0",
			capabilities: { extensions: ["extensions/index.ts"] },
			integrity: {
				"extensions/index.ts": `sha256-${createHash("sha256").update(content).digest("base64")}`,
			},
		}),
		"utf8",
	);
	return root;
}

describe("controlled plugin registry", () => {
	it("keeps plugins disabled until confirmed and persists the decision", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-plugin-registry-"));
		const root = createPlugin(temp);
		const statePath = join(temp, "plugin-state.json");
		const registry = new PluginRegistry({ statePath, hostVersion: "0.84.1" });

		const entry = registry.register(root, "local:test");
		expect(entry.enabled).toBe(false);
		expect(await registry.setEnabled("registry-plugin", true, async () => false)).toBe(false);
		expect(await registry.setEnabled("registry-plugin", true, async () => true)).toBe(true);
		expect(registry.resolveEnabled().extensions).toEqual([join(root, "extensions", "index.ts")]);

		const reloaded = new PluginRegistry({ statePath, hostVersion: "0.84.1" });
		expect(reloaded.register(root, "local:test").enabled).toBe(true);
	});

	it("requires confirmation again after the manifest fingerprint changes", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-plugin-refresh-"));
		const root = createPlugin(temp);
		const statePath = join(temp, "plugin-state.json");
		const first = new PluginRegistry({ statePath, hostVersion: "0.84.1" });
		first.register(root, "local:test");
		await first.setEnabled("registry-plugin", true, async () => true);

		createPlugin(temp, "export default () => { console.log('changed'); };\n");
		const refreshed = new PluginRegistry({ statePath, hostVersion: "0.84.1" });
		const entry = refreshed.register(root, "local:test");
		expect(entry.enabled).toBe(false);
		expect(entry.requiresConfirmation).toBe(true);
	});

	it("keeps controlled package resources out of the loader until approved", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-plugin-loader-"));
		const root = createPlugin(temp);
		const agentDir = join(temp, "agent");
		const settings = SettingsManager.inMemory();
		settings.setPackages([root]);
		const createManager = () => new DefaultPackageManager({ cwd: temp, agentDir, settingsManager: settings });

		expect((await createManager().resolve()).extensions).toEqual([]);
		const registry = new PluginRegistry({ statePath: join(agentDir, "plugin-state.json"), hostVersion: "0.84.1" });
		registry.register(root, root);
		await registry.setEnabled("registry-plugin", true, async () => true);
		expect((await createManager().resolve()).extensions.map((resource) => resource.path)).toEqual([
			join(root, "extensions", "index.ts"),
		]);
	});
});
