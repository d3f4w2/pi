import { describe, expect, it, vi } from "vitest";
import { type CliDoctorSnapshot, runCliDoctorChecks, runDoctorCommand } from "../src/cli/doctor-command.ts";

function snapshot(overrides: Partial<CliDoctorSnapshot> = {}): CliDoctorSnapshot {
	return {
		appName: "pigo",
		appVersion: "0.84.1",
		nodeVersion: "v24.12.0",
		platform: "linux",
		arch: "x64",
		cwd: "/repo",
		entryPath: "/opt/pigo/dist/bundle/cli.js",
		packageDir: "/opt/pigo",
		commands: {
			git: { path: "/usr/bin/git", version: "git version 2.46.0" },
			npm: { path: "/usr/bin/npm", version: "11.8.0" },
			shell: { path: "/bin/bash", version: "GNU bash 5.2" },
		},
		languages: ["typescript"],
		settingsErrors: [],
		paths: {
			settings: "~/.pi/agent/settings.json",
			projectSettings: "/repo/.pi/settings.json",
			models: "~/.pi/agent/models.json",
			auth: "~/.pi/agent/auth.json",
		},
		configFiles: { settings: true, projectSettings: false, models: true, auth: true },
		...overrides,
	};
}

function commandHarness(fixedSnapshot: CliDoctorSnapshot) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	return {
		stdout,
		stderr,
		exitCodes,
		dependencies: {
			collectSnapshot: () => fixedSnapshot,
			writeStdout: (value: string) => stdout.push(value),
			writeStderr: (value: string) => stderr.push(value),
			setExitCode: (value: number) => exitCodes.push(value),
		},
	};
}

describe("standalone doctor command", () => {
	it("reports a healthy local runtime as text", () => {
		const harness = commandHarness(snapshot());

		const exitCode = runDoctorCommand([], harness.dependencies);

		expect(exitCode).toBe(0);
		expect(harness.exitCodes).toEqual([0]);
		expect(harness.stderr).toEqual([]);
		expect(harness.stdout.join("\n")).toContain("Pigo 健康检查");
		expect(harness.stdout.join("\n")).toContain("git version 2.46.0");
		expect(harness.stdout.join("\n")).toContain("GNU bash 5.2");
	});

	it("returns an error when Git is unavailable", () => {
		const fixed = snapshot({ commands: { ...snapshot().commands, git: undefined } });
		const harness = commandHarness(fixed);

		const exitCode = runDoctorCommand([], harness.dependencies);

		expect(exitCode).toBe(1);
		expect(harness.exitCodes).toEqual([1]);
		expect(harness.stdout.join("\n")).toContain("没有找到 Git");
	});

	it("warns about Windows System32 without failing the command", () => {
		const fixed = snapshot({ platform: "win32", cwd: "C:\\Windows\\System32", inWindowsSystemDirectory: true });
		const report = runCliDoctorChecks(fixed);

		expect(report.summary.error).toBe(0);
		expect(report.findings).toContainEqual(expect.objectContaining({ id: "cwd", severity: "warning" }));
	});

	it("reports settings parse failures without exposing raw settings contents", () => {
		const fixed = snapshot({
			settingsErrors: [{ scope: "global", message: "settings.json 不是有效 JSON" }],
		});
		const harness = commandHarness(fixed);

		runDoctorCommand([], harness.dependencies);

		expect(harness.exitCodes).toEqual([1]);
		expect(harness.stdout.join("\n")).toContain("settings.json 不是有效 JSON");
	});

	it("writes structured JSON without environment or credential contents", () => {
		const harness = commandHarness(snapshot());

		runDoctorCommand(["--json"], harness.dependencies);

		const output = harness.stdout.join("\n");
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.version).toBe(1);
		expect(output).not.toContain('"env"');
		expect(output).not.toContain("super-secret");
	});

	it("prints command help without collecting a snapshot", () => {
		const collectSnapshot = vi.fn(() => snapshot());
		const harness = commandHarness(snapshot());

		const exitCode = runDoctorCommand(["--help"], { ...harness.dependencies, collectSnapshot });

		expect(exitCode).toBe(0);
		expect(collectSnapshot).not.toHaveBeenCalled();
		expect(harness.stdout.join("\n")).toContain("pigo doctor [--json]");
	});

	it("rejects unknown options with a usage exit code", () => {
		const harness = commandHarness(snapshot());

		const exitCode = runDoctorCommand(["--remote"], harness.dependencies);

		expect(exitCode).toBe(2);
		expect(harness.exitCodes).toEqual([2]);
		expect(harness.stderr.join("\n")).toContain('未知选项 "--remote"');
	});

	it("redacts unexpected collection errors", () => {
		const harness = commandHarness(snapshot());

		const exitCode = runDoctorCommand([], {
			...harness.dependencies,
			collectSnapshot: () => {
				throw new Error("failed with sk-super-secret-value");
			},
		});

		expect(exitCode).toBe(1);
		expect(harness.exitCodes).toEqual([1]);
		expect(harness.stderr).toEqual(["健康检查失败：failed with [已隐藏]"]);
	});
});
