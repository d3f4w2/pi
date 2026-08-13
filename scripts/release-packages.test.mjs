import assert from "node:assert/strict";
import test from "node:test";
import { PIGO_PACKAGE_NAME } from "./pigo-package.mjs";
import { getPigoProductPackage, getPublicWorkspacePackages } from "./release-packages.mjs";

test("derives the generated Pigo product from the lockstep workspace version", () => {
	const workspacePackages = getPublicWorkspacePackages();
	const pigo = getPigoProductPackage();

	assert.equal(pigo.name, PIGO_PACKAGE_NAME);
	assert.equal(pigo.version, workspacePackages[0]?.version);
});
