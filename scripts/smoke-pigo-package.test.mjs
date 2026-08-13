import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	createIsolatedPigoEnvironment,
	createSmokeReceiptEnvelope,
	getGlobalBinDirectory,
	resolveNpmCliPath,
	validateDoctorPayload,
	validateInteractiveCommandContract,
	validatePackedPigoMetadata,
} from "./smoke-pigo-package.mjs";

test("creates a deterministic completed receipt for installed CI smoke tests", () => {
	const first = createSmokeReceiptEnvelope();
	const second = createSmokeReceiptEnvelope();

	assert.deepEqual(first, second);
	assert.equal(first.receipt.result.outcome, "completed");
	assert.match(first.integrity.digest, /^[a-f0-9]{64}$/);
});

test("resolves npm global bin directories by platform", () => {
	assert.equal(getGlobalBinDirectory("C:\\pigo-prefix", "win32"), "C:\\pigo-prefix");
	assert.equal(getGlobalBinDirectory("/tmp/pigo-prefix", "linux"), join("/tmp/pigo-prefix", "bin"));
	assert.equal(getGlobalBinDirectory("/tmp/pigo-prefix", "darwin"), join("/tmp/pigo-prefix", "bin"));
});

test("prepends only the isolated npm bin and disables network startup work", () => {
	const env = createIsolatedPigoEnvironment(
		"/tmp/pigo-prefix/bin",
		"/tmp/pigo-config",
		{ PATH: "/usr/bin", PI_OFFLINE: "0" },
		"linux",
	);

	assert.equal(env.PATH, "/tmp/pigo-prefix/bin:/usr/bin");
	assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/pigo-config");
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");
});

test("resolves npm-cli.js beside Node when npm_execpath is unavailable", () => {
	const expected = join("C:\\node", "node_modules", "npm", "bin", "npm-cli.js");
	const resolved = resolveNpmCliPath({
		npmExecPath: undefined,
		nodeExecPath: "C:\\node\\node.exe",
		fileExists: (candidate) => candidate === expected,
	});

	assert.equal(resolved, expected);
});

test("validates packed product identity, command, and required files", () => {
	const errors = validatePackedPigoMetadata({
		name: "pi-gogogo",
		version: "0.84.1",
		files: [
			{ path: "package/package.json" },
			{ path: "package/README.md" },
			{ path: "package/LICENSE" },
			{ path: "package/CHANGELOG.md" },
			{ path: "package/docs/index.md" },
			{ path: "package/dist/bundle/cli.js" },
			{ path: "package/dist/bundle/image-resize-worker.js" },
			{ path: "package/dist/bundle/run-verify-worker.js" },
			{ path: "package/dist/modes/interactive/theme/dark.json" },
			{ path: "package/dist/modes/interactive/assets/clankolas.png" },
			{ path: "package/dist/core/export-html/template.html" },
			{ path: "package/dist/core/sandbox/windows/pi-sandbox.ps1" },
		],
	});

	assert.deepEqual(errors, []);
	assert.ok(
		validatePackedPigoMetadata({ name: "other", version: "0.84.1", files: [] }).some((error) =>
			error.includes("pi-gogogo"),
		),
	);
});

test("requires exactly one installed /run command and no internal /ci command", () => {
	const commands = [
		{ name: "run", source: "extension" },
		{ name: "help", source: "extension" },
		{ name: "run", source: "prompt" },
	];
	assert.deepEqual(validateInteractiveCommandContract(commands), []);
	assert.ok(
		validateInteractiveCommandContract([...commands, { name: "ci", source: "extension" }]).some((error) =>
			error.includes("/ci"),
		),
	);
	assert.ok(
		validateInteractiveCommandContract(commands.filter((command) => command.name !== "run")).some((error) =>
			error.includes("/run"),
		),
	);
});

test("validates redacted doctor JSON and the System32 warning", () => {
	const payload = {
		version: 1,
		product: { name: "pigo", version: "0.84.1" },
		runtime: { node: "v24.0.0", platform: "win32", arch: "x64", cwd: "C:\\Windows\\System32" },
		paths: { settings: "~/.pi/agent/settings.json" },
		report: {
			findings: [
				{
					id: "cwd",
					area: "core",
					severity: "warning",
					label: "当前工作目录",
					detail: "C:\\Windows\\System32 是 Windows 系统目录，不应作为代码项目运行。",
					fix: "先 cd 到项目目录，再运行 pigo。",
				},
			],
			summary: { ok: 0, info: 0, warning: 1, error: 0 },
			severity: "warning",
		},
	};

	assert.deepEqual(validateDoctorPayload(payload, { requireSystemDirectoryWarning: true }), []);
	assert.ok(
		validateDoctorPayload({ ...payload, env: { SECRET: "sk-secret" } }, { requireSystemDirectoryWarning: true }).some(
			(error) => error.includes("environment") || error.includes("secret"),
		),
	);
});
