import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import type {
	ConfiguredPackage,
	MissingSourceAction,
	PackageManager,
	ProgressCallback,
	ResolvedPaths,
} from "../src/core/package-manager.ts";
import { PluginRegistry } from "../src/core/plugins/registry.ts";
import { createPluginsExtension, parsePluginCommand } from "../src/extensions/plugins/index.ts";

function emptyPaths(): ResolvedPaths {
	return { extensions: [], skills: [], prompts: [], themes: [] };
}

function writePlugin(root: string, content: string): void {
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions", "index.ts"), content, "utf8");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "controlled", version: "1.0.0" }), "utf8");
	writeFileSync(
		join(root, "pi-plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "controlled",
			version: "1.0.0",
			capabilities: { extensions: ["extensions/index.ts"] },
			integrity: {
				"extensions/index.ts": `sha256-${createHash("sha256").update(content).digest("base64")}`,
			},
		}),
		"utf8",
	);
}

class FakePackageManager implements PackageManager {
	readonly path: string;
	configured: ConfiguredPackage[] = [];
	nextContent: string | undefined;
	progress: ProgressCallback | undefined;

	constructor(path: string) {
		this.path = path;
	}

	async resolve(_onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		return emptyPaths();
	}

	async install(source: string): Promise<void> {
		if (!existsSync(this.path) && this.nextContent) writePlugin(this.path, this.nextContent);
		this.progress?.({ type: "complete", action: "install", source });
	}

	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source);
		this.addSourceToSettings(source, options);
	}

	async remove(): Promise<void> {}

	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		return this.removeSourceFromSettings(source, options);
	}

	async update(): Promise<void> {}

	listConfiguredPackages(): ConfiguredPackage[] {
		return [...this.configured];
	}

	async resolveExtensionSources(): Promise<ResolvedPaths> {
		return emptyPaths();
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		this.configured.push({
			source,
			scope: options?.local ? "project" : "user",
			filtered: false,
			installedPath: this.path,
		});
		return true;
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		const scope = options?.local ? "project" : "user";
		const previous = this.configured.length;
		this.configured = this.configured.filter((entry) => entry.source !== source || entry.scope !== scope);
		return previous !== this.configured.length;
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progress = callback;
	}

	getInstalledPath(): string {
		return this.path;
	}
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(root: string): {
	manager: FakePackageManager;
	run: (args: string, confirmations?: boolean[]) => Promise<void>;
	reload: ReturnType<typeof vi.fn>;
	statePath: string;
	backupStatePath: string;
} {
	const pluginPath = join(root, "installed", "controlled");
	writePlugin(pluginPath, "export default () => 'old';\n");
	const manager = new FakePackageManager(pluginPath);
	const statePath = join(root, "plugin-state.json");
	const backupStatePath = join(root, "plugin-backups.json");
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const api = {
		on: vi.fn(),
		registerCommand: (
			_name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	createPluginsExtension({
		createEnvironment: () => ({
			manager,
			registry: new PluginRegistry({ statePath, hostVersion: "0.84.1" }),
			language: "zh-CN",
			backupStatePath,
		}),
	})(api);
	const reload = vi.fn(async () => {});
	return {
		manager,
		reload,
		statePath,
		backupStatePath,
		run: async (args, confirmations = [true]) => {
			const queue = [...confirmations];
			const context = {
				isProjectTrusted: () => true,
				reload,
				ui: {
					notify: vi.fn(),
					confirm: vi.fn(async () => queue.shift() ?? false),
					setStatus: vi.fn(),
				},
			} as unknown as ExtensionCommandContext;
			await handler?.(args, context);
		},
	};
}

describe("controlled plugin extension", () => {
	it("parses management operations and project scope", () => {
		expect(parsePluginCommand("add npm:example --project")).toEqual({
			operation: "add",
			source: "npm:example",
			scope: "project",
		});
		expect(parsePluginCommand("rollback npm:example").operation).toBe("rollback");
	});

	it("persists a package only after manifest verification and approval", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-plugins-ui-"));
		roots.push(root);
		const test = harness(root);

		await test.run("add npm:controlled", [true]);

		expect(test.manager.configured).toHaveLength(1);
		expect(test.reload).toHaveBeenCalledOnce();
	});

	it("restores the old files when an update is rejected", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-plugins-reject-"));
		roots.push(root);
		const test = harness(root);
		await test.run("add npm:controlled", [true]);
		test.manager.nextContent = "export default () => 'new';\n";

		await test.run("update npm:controlled", [true, false]);

		expect(readFileSync(join(test.manager.path, "extensions", "index.ts"), "utf8")).toContain("old");
	});

	it("keeps one verified backup and supports reversible rollback", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-plugins-rollback-"));
		roots.push(root);
		const test = harness(root);
		await test.run("add npm:controlled", [true]);
		test.manager.nextContent = "export default () => 'new';\n";
		await test.run("update npm:controlled", [true, true]);
		expect(readFileSync(join(test.manager.path, "extensions", "index.ts"), "utf8")).toContain("new");

		await test.run("rollback npm:controlled", [true]);

		expect(readFileSync(join(test.manager.path, "extensions", "index.ts"), "utf8")).toContain("old");
	});

	it("restores files and approval when reload fails after an update", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-plugins-reload-"));
		roots.push(root);
		const test = harness(root);
		await test.run("add npm:controlled", [true]);
		test.manager.nextContent = "export default () => 'new';\n";
		test.reload.mockRejectedValueOnce(new Error("reload failed"));

		await test.run("update npm:controlled", [true, true]);

		expect(readFileSync(join(test.manager.path, "extensions", "index.ts"), "utf8")).toContain("old");
		const restored = new PluginRegistry({ statePath: test.statePath, hostVersion: "0.84.1" }).register(
			test.manager.path,
			"npm:controlled",
		);
		expect(restored.enabled).toBe(true);
		expect(existsSync(test.backupStatePath)).toBe(true);
		expect(JSON.parse(readFileSync(test.backupStatePath, "utf8")).backups).toEqual({});
	});
});
