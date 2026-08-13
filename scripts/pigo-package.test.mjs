import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	assertSafePigoPackageOutput,
	createPigoPackageManifest,
	PIGO_PACKAGE_NAME,
	PIGO_UPDATE_URL,
	validatePigoPackageFiles,
	validatePigoPackageManifest,
	validatePigoReleaseWorkflow,
} from "./pigo-package.mjs";

const sourceManifest = {
	name: "@earendil-works/pi-coding-agent",
	version: "1.2.3",
	description: "upstream description",
	type: "module",
	piConfig: {
		name: "pigo",
		envPrefix: "PI",
		configDir: ".pi",
	},
	bin: {
		pigo: "dist/bundle/cli.js",
	},
	dependencies: {
		"@earendil-works/pi-ai": "^1.2.3",
		chalk: "5.6.2",
		jiti: "2.7.0",
	},
	optionalDependencies: {
		"@mariozechner/clipboard": "0.3.9",
	},
	overrides: {
		protobufjs: "7.6.5",
	},
	engines: {
		node: ">=22.19.0",
	},
	license: "MIT",
};

test("creates a standalone Pigo CLI product manifest", () => {
	const manifest = createPigoPackageManifest(sourceManifest);

	assert.equal(manifest.name, PIGO_PACKAGE_NAME);
	assert.equal(manifest.version, "1.2.3");
	assert.deepEqual(manifest.bin, { pigo: "dist/bundle/cli.js" });
	assert.deepEqual(manifest.piConfig, {
		name: "pigo",
		envPrefix: "PI",
		configDir: ".pi",
		updateUrl: PIGO_UPDATE_URL,
	});
	assert.deepEqual(manifest.dependencies, {
		chalk: "5.6.2",
		jiti: "2.7.0",
	});
	assert.deepEqual(manifest.optionalDependencies, {
		"@mariozechner/clipboard": "0.3.9",
	});
	assert.equal(manifest.repository.url, "git+https://github.com/d3f4w2/pi-Gogogo.git");
	assert.equal(manifest.homepage, "https://github.com/d3f4w2/pi-Gogogo#readme");
	assert.equal(manifest.scripts, undefined);
	assert.equal(manifest.main, undefined);
	assert.equal(manifest.exports, undefined);
	assert.deepEqual(validatePigoPackageManifest(manifest), []);
});

test("rejects legacy bins, upstream identity, lifecycle scripts, and loose versions", () => {
	const manifest = {
		...createPigoPackageManifest(sourceManifest),
		name: "@earendil-works/pi-coding-agent",
		bin: { pi: "dist/bundle/cli.js" },
		dependencies: { chalk: "^5.6.2" },
		scripts: { postinstall: "node install.js" },
	};
	const errors = validatePigoPackageManifest(manifest);

	assert.ok(errors.some((error) => error.includes(PIGO_PACKAGE_NAME)));
	assert.ok(errors.some((error) => error.includes("pigo")));
	assert.ok(errors.some((error) => error.includes("pi")));
	assert.ok(errors.some((error) => error.includes("postinstall")));
	assert.ok(errors.some((error) => error.includes("exact version")));
});

test("requires the built CLI and runtime assets in the product package", () => {
	const validFiles = [
		"CHANGELOG.md",
		"LICENSE",
		"README.md",
		"docs/index.md",
		"dist/bundle/cli.js",
		"dist/bundle/image-resize-worker.js",
		"dist/bundle/run-verify-worker.js",
		"dist/modes/interactive/theme/dark.json",
		"dist/modes/interactive/assets/markdown-alert-note.png",
		"dist/core/export-html/template.html",
		"dist/core/sandbox/windows/sandbox-exec.ps1",
		"package.json",
	];

	assert.deepEqual(validatePigoPackageFiles(validFiles), []);
	const errors = validatePigoPackageFiles(validFiles.filter((path) => path !== "dist/bundle/cli.js"));
	assert.ok(errors.some((error) => error.includes("dist/bundle/cli.js")));
});

test("allows generated output only under the repository artifact root or OS temp", () => {
	const repoRoot = resolve("C:/repo");
	assert.doesNotThrow(() => assertSafePigoPackageOutput(resolve(repoRoot, ".artifacts/pi-gogogo/package"), repoRoot));
	assert.doesNotThrow(() =>
		assertSafePigoPackageOutput(join(tmpdir(), "pigo-package-test", "package"), repoRoot),
	);
	assert.throws(() => assertSafePigoPackageOutput(repoRoot, repoRoot));
	assert.throws(() => assertSafePigoPackageOutput(resolve(repoRoot, "packages/coding-agent"), repoRoot));
	assert.throws(() => assertSafePigoPackageOutput(resolve(repoRoot, ".artifacts/pi-gogogo"), repoRoot));
});

test("requires a fork-owned, OIDC-capable, publicly verified Pigo release workflow", () => {
	const workflow = `
if: github.repository == 'd3f4w2/pi-Gogogo'
permissions:
  id-token: write
token: \${{ secrets.NPM_PUBLISH_TOKEN }}
publish: node scripts/publish.mjs --pigo-only
verify: node scripts/smoke-published-pigo.mjs --version 1.2.3
`;
	assert.deepEqual(validatePigoReleaseWorkflow(workflow), []);
	assert.ok(validatePigoReleaseWorkflow(workflow.replace(" --pigo-only", "")).some((error) => error.includes("Pigo-only")));
});
