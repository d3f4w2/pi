import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageDir, "dist");
const entrypoint = join(distDir, "cli.js");
const bundleDir = join(distDir, "bundle");

const external = [
	"@anthropic-ai/sandbox-runtime",
	"@ast-grep/napi",
	"@mariozechner/clipboard",
	"@silvia-odwyer/photon-node",
	"@mozilla/readability",
	"jiti",
	"jsdom",
	"turndown",
	"unpdf",
];

await rm(bundleDir, { recursive: true, force: true });
await mkdir(bundleDir, { recursive: true });

await build({
	entryPoints: [entrypoint],
	outdir: bundleDir,
	bundle: true,
	platform: "node",
	format: "esm",
	splitting: true,
	minify: true,
	sourcemap: "external",
	external,
	banner: {
		js: [
			'import { createRequire as __createRequire } from "node:module";',
			'import { fileURLToPath as __fileURLToPath } from "node:url";',
			'import { dirname as __pathDirname } from "node:path";',
			"const require = __createRequire(import.meta.url);",
			"const __filename = __fileURLToPath(import.meta.url);",
			"const __dirname = __pathDirname(__filename);",
		].join("\n"),
	},
});

await chmod(join(bundleDir, "cli.js"), 0o755);
