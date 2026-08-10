import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageMetadata {
	version?: string;
	piConfig?: { name?: string };
}

function readPackageMetadata(): PackageMetadata {
	let directory = dirname(fileURLToPath(import.meta.url));
	while (directory !== dirname(directory)) {
		const packageJsonPath = join(directory, "package.json");
		if (existsSync(packageJsonPath)) {
			return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageMetadata;
		}
		directory = dirname(directory);
	}
	return {};
}

const metadata = readPackageMetadata();

export const APP_NAME = metadata.piConfig?.name || "pi";
export const VERSION = metadata.version || "0.0.0";
