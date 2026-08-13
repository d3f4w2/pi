import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { PIGO_PACKAGE_NAME } from "./pigo-package.mjs";

export function getPublicWorkspacePackages() {
	return findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}

export function getPigoProductPackage() {
	const workspacePackages = getPublicWorkspacePackages();
	const versions = [...new Set(workspacePackages.map((pkg) => pkg.version))];
	if (versions.length !== 1) {
		throw new Error(`Public workspace packages are not lockstep versioned: ${versions.join(", ")}`);
	}
	if (workspacePackages.some((pkg) => pkg.name === PIGO_PACKAGE_NAME)) {
		throw new Error(`${PIGO_PACKAGE_NAME} must remain a generated product package, not a workspace package`);
	}
	return { name: PIGO_PACKAGE_NAME, version: versions[0] };
}
