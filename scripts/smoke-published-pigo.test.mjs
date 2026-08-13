import assert from "node:assert/strict";
import test from "node:test";
import { validatePublishedPigoMetadata } from "./smoke-published-pigo.mjs";

test("accepts exact Pigo registry metadata with immutable integrity", () => {
	assert.deepEqual(
		validatePublishedPigoMetadata(
			{
				name: "pi-gogogo",
				version: "0.84.1",
				dist: {
					tarball: "https://registry.npmjs.org/pi-gogogo/-/pi-gogogo-0.84.1.tgz",
					integrity: "sha512-proof",
				},
			},
			"0.84.1",
		),
		[],
	);
});

test("rejects a mismatched version or incomplete registry evidence", () => {
	const errors = validatePublishedPigoMetadata(
		{ name: "pi-gogogo", version: "0.84.0", dist: { tarball: "http://example.test/package.tgz" } },
		"0.84.1",
	);
	assert.ok(errors.some((error) => error.includes("0.84.1")));
	assert.ok(errors.some((error) => error.includes("HTTPS")));
	assert.ok(errors.some((error) => error.includes("sha512")));
});
