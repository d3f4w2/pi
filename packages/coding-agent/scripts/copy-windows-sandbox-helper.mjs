import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
	if (process.arch !== "x64" && process.arch !== "arm64") {
		throw new Error(`Unsupported Windows sandbox architecture: ${process.arch}`);
	}
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const source = path.resolve(
		packageRoot,
		"..",
		"..",
		"node_modules",
		"@anthropic-ai",
		"sandbox-runtime",
		"vendor",
		"srt-win",
		process.arch,
		"srt-win.exe",
	);
	const destinationDirectory = path.join(packageRoot, "dist", "sandbox");
	await mkdir(destinationDirectory, { recursive: true });
	await copyFile(source, path.join(destinationDirectory, "srt-win.exe"));
}
