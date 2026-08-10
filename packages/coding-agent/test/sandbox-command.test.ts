import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildPosixCommand,
	buildPowerShellCommand,
	decodeSandboxLaunchRequest,
	encodeSandboxLaunchRequest,
} from "../src/core/sandbox/command.ts";
import { createSandboxEnvironment } from "../src/core/sandbox/environment.ts";

describe("sandbox environment", () => {
	it("keeps only operational variables and replaces the user home and temporary directory", () => {
		const environment = createSandboxEnvironment(
			{
				PATH: "/usr/local/bin:/usr/bin",
				HOME: "/home/alice",
				LANG: "en_US.UTF-8",
				TERM: "xterm-256color",
				CI: "1",
				OPENAI_API_KEY: "secret-key",
				AWS_SECRET_ACCESS_KEY: "secret-aws",
				PI_SESSION_FILE: "/home/alice/.pi/session.jsonl",
				NODE_OPTIONS: "--require /tmp/inject.js",
				LD_PRELOAD: "/tmp/inject.so",
				HTTP_PROXY: "http://attacker.invalid:8080",
			},
			{ tempRoot: "/tmp/pi-owned", platform: "linux" },
		);

		expect(environment).toMatchObject({
			PATH: "/usr/local/bin:/usr/bin",
			HOME: "/tmp/pi-owned/home",
			TMPDIR: "/tmp/pi-owned/tmp",
			TEMP: "/tmp/pi-owned/tmp",
			TMP: "/tmp/pi-owned/tmp",
			LANG: "en_US.UTF-8",
			TERM: "xterm-256color",
			CI: "1",
			SANDBOX_RUNTIME: "1",
		});
		for (const deniedName of [
			"OPENAI_API_KEY",
			"AWS_SECRET_ACCESS_KEY",
			"PI_SESSION_FILE",
			"NODE_OPTIONS",
			"LD_PRELOAD",
			"HTTP_PROXY",
		]) {
			expect(environment).not.toHaveProperty(deniedName);
		}
	});

	it("accepts proxy variables only from the trusted broker", () => {
		const environment = createSandboxEnvironment(
			{ PATH: "C:\\Windows\\System32", HTTPS_PROXY: "http://attacker.invalid" },
			{
				tempRoot: "C:\\Temp\\pi-owned",
				platform: "win32",
				proxy: { http: "http://127.0.0.1:43120", noProxy: "" },
			},
		);

		expect(environment.HTTP_PROXY).toBe("http://127.0.0.1:43120");
		expect(environment.HTTPS_PROXY).toBe("http://127.0.0.1:43120");
		expect(environment.NO_PROXY).toBe("");
		expect(environment.HOME).toBe(path.win32.join("C:\\Temp\\pi-owned", "home"));
		expect(environment.USERPROFILE).toBe(path.win32.join("C:\\Temp\\pi-owned", "home"));
	});
});

describe("sandbox command encoding", () => {
	it("quotes every POSIX argument without allowing shell expansion", () => {
		expect(
			buildPosixCommand("/opt/My Tool/bin/tool", [
				"",
				"plain",
				"two words",
				"a'b",
				"$(touch escaped)",
				"semi;colon",
			]),
		).toBe("'/opt/My Tool/bin/tool' '' plain 'two words' 'a'\"'\"'b' '$(touch escaped)' 'semi;colon'");
	});

	it("quotes PowerShell argv and environment values as literals", () => {
		expect(
			buildPowerShellCommand("C:\\Program Files\\tool.exe", ["two words", "a'b", "$(touch escaped)", "; exit 9"], {
				HOME: "C:\\Temp\\pi home",
				SANDBOX_RUNTIME: "1",
			}),
		).toBe(
			"$env:HOME='C:\\Temp\\pi home'; $env:SANDBOX_RUNTIME='1'; & 'C:\\Program Files\\tool.exe' 'two words' 'a''b' '$(touch escaped)' '; exit 9'; exit $LASTEXITCODE",
		);
	});

	it("round-trips a versioned Windows launcher request", () => {
		const request = {
			version: 1 as const,
			command: "C:\\Program Files\\Git\\bin\\bash.exe",
			args: ["-lc", "printf '%s' \"two words\""],
			cwd: "C:\\work tree",
			workspaceRoot: "C:\\work tree",
			tempRoot: "C:\\Temp\\pi sandbox",
			readOnly: false,
			protectedWritePaths: ["C:\\work tree\\.git", "C:\\work tree\\.pi"],
		};

		expect(decodeSandboxLaunchRequest(encodeSandboxLaunchRequest(request))).toEqual(request);
	});

	it("rejects NUL bytes before a request reaches a native launcher", () => {
		expect(() =>
			encodeSandboxLaunchRequest({
				version: 1,
				command: "cmd.exe\0hidden",
				args: [],
				cwd: "C:\\work",
				workspaceRoot: "C:\\work",
				tempRoot: "C:\\temp",
				readOnly: true,
				protectedWritePaths: [],
			}),
		).toThrow("NUL");
	});
});
