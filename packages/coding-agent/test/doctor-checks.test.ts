import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectProjectLanguages,
	findExecutableOnPath,
	resolveDoctorShell,
	runDoctorChecks,
} from "../src/extensions/doctor/checks.ts";
import { formatDoctorReport } from "../src/extensions/doctor/report.ts";
import type { DoctorFileProbes, DoctorSnapshot } from "../src/extensions/doctor/types.ts";

function normalize(value: string): string {
	return path.win32.normalize(value).toLowerCase();
}

function probes(paths: string[]): DoctorFileProbes {
	const files = new Set(paths.map(normalize));
	return {
		fileExists: (candidate) => files.has(normalize(candidate)),
		isExecutable: (candidate) => files.has(normalize(candidate)),
	};
}

function snapshot(overrides: Partial<DoctorSnapshot> = {}): DoctorSnapshot {
	return {
		platform: "win32",
		cwd: "C:\\repo",
		env: { Path: "C:\\Tools;C:\\Program Files\\Git\\cmd", PATHEXT: ".EXE;.CMD;.BAT" },
		settingsErrors: [],
		availableModelCount: 2,
		currentModel: { provider: "openai", id: "gpt-test", hasConfiguredAuth: true },
		registeredTools: ["read", "bash", "edit", "write", "grep", "lsp", "code_search", "web_search"],
		activeTools: ["read", "bash", "edit", "write", "grep", "lsp", "web_search"],
		paths: {
			settings: "C:\\Users\\test\\.pi\\agent\\settings.json",
			projectSettings: "C:\\repo\\.pi\\settings.json",
			models: "C:\\Users\\test\\.pi\\agent\\models.json",
			auth: "C:\\Users\\test\\.pi\\agent\\auth.json",
		},
		configFiles: { settings: true, projectSettings: false, models: true, auth: true },
		isBunBinary: false,
		...overrides,
	};
}

describe("doctor executable resolution", () => {
	it("resolves Windows PATHEXT commands and Git Bash beside Git/cmd", () => {
		const fileProbes = probes([
			"C:\\Windows\\System32\\bash.exe",
			"C:\\Tools\\mgrep.CMD",
			"D:\\app\\Git\\bin\\bash.exe",
		]);
		const state = snapshot({
			env: {
				Path: "C:\\Windows\\System32;C:\\Tools;D:\\app\\Git\\cmd",
				PATHEXT: ".EXE;.CMD;.BAT",
			},
		});

		expect(findExecutableOnPath("mgrep", state, fileProbes)).toBe("C:\\Tools\\mgrep.CMD");
		expect(resolveDoctorShell(state, fileProbes)).toMatchObject({
			path: "D:\\app\\Git\\bin\\bash.exe",
		});
	});

	it("never accepts the legacy Windows WSL bash relay", () => {
		const state = snapshot({ env: { Path: "C:\\Windows\\System32" } });
		const fileProbes = probes(["C:\\Windows\\System32\\bash.exe"]);

		expect(resolveDoctorShell(state, fileProbes)).toBeUndefined();
	});

	it("requires Unix execute permission", () => {
		const state = snapshot({ platform: "linux", env: { PATH: "/tools:/usr/bin" }, cwd: "/repo" });
		const fileProbes: DoctorFileProbes = {
			fileExists: (candidate) => candidate === "/tools/mgrep" || candidate === "/usr/bin/bash",
			isExecutable: (candidate) => candidate === "/usr/bin/bash",
		};

		expect(findExecutableOnPath("mgrep", state, fileProbes)).toBeUndefined();
		expect(resolveDoctorShell(state, fileProbes)?.path).toBe("/usr/bin/bash");
	});

	it("continues after an inaccessible PATH entry", () => {
		const state = snapshot({ env: { Path: "C:\\Denied;C:\\Tools", PATHEXT: ".CMD" } });
		const fileProbes: DoctorFileProbes = {
			fileExists: (candidate) => {
				if (candidate.startsWith("C:\\Denied")) throw new Error("access denied");
				return normalize(candidate) === normalize("C:\\Tools\\mgrep.CMD");
			},
			isExecutable: () => true,
		};

		expect(findExecutableOnPath("mgrep", state, fileProbes)).toBe("C:\\Tools\\mgrep.CMD");
	});
});

describe("doctor project detection", () => {
	it("detects only root-marker languages without walking the repository", () => {
		const state = snapshot();
		const requested: string[] = [];
		const fileProbes: DoctorFileProbes = {
			fileExists: (candidate) => {
				requested.push(candidate);
				return candidate.endsWith("tsconfig.json") || candidate.endsWith("go.mod");
			},
			isExecutable: () => false,
		};

		expect(detectProjectLanguages(state, fileProbes)).toEqual(["typescript", "go"]);
		expect(requested).toHaveLength(10);
		expect(requested.every((candidate) => path.win32.dirname(candidate) === "C:\\repo")).toBe(true);
	});
});

describe("doctor checks and report", () => {
	it("separates core failures, relevant LSP warnings, and optional tools", () => {
		const state = snapshot({
			availableModelCount: 0,
			currentModel: undefined,
			registeredTools: ["read", "edit", "write", "grep", "lsp", "code_search", "web_search"],
			activeTools: ["read", "edit", "write", "grep", "lsp"],
		});
		const fileProbes = probes(["C:\\repo\\pyproject.toml", "C:\\Program Files\\Git\\bin\\bash.exe"]);
		const report = runDoctorChecks(state, fileProbes);

		expect(report.severity).toBe("error");
		expect(report.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "models", severity: "error", fix: expect.stringContaining("/api") }),
				expect.objectContaining({ id: "core-tools", severity: "error" }),
				expect.objectContaining({ id: "lsp-python", severity: "warning", fix: "pip install basedpyright" }),
				expect.objectContaining({ id: "mgrep", severity: "info" }),
			]),
		);
	});

	it("keeps optional capability gaps non-blocking", () => {
		const report = runDoctorChecks(snapshot(), probes(["C:\\Program Files\\Git\\bin\\bash.exe"]));

		expect(report.summary.error).toBe(0);
		expect(report.summary.warning).toBe(0);
		expect(report.findings.find((finding) => finding.id === "mgrep")?.severity).toBe("info");
		expect(report.findings.find((finding) => finding.id === "web")?.severity).toBe("ok");
	});

	it("never includes credential or environment values and bounds output", () => {
		const secret = "sk-super-secret-value";
		const state = snapshot({
			env: {
				Path: "C:\\Program Files\\Git\\cmd",
				BRAVE_API_KEY: secret,
				OPENAI_API_KEY: secret,
			},
			settingsErrors: [{ scope: "project", message: "x".repeat(20_000) }],
			modelError: `provider rejected ${secret}`,
		});
		const report = runDoctorChecks(state, probes(["C:\\Program Files\\Git\\bin\\bash.exe"]));
		const output = formatDoctorReport(report, state.paths);

		expect(output).not.toContain(secret);
		expect(output).not.toContain("OPENAI_API_KEY");
		expect(output).toContain("Brave Key 已配置");
		expect(output.length).toBeLessThanOrEqual(12_000);
	});
});
