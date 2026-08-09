import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { createDoctorExtension } from "../src/extensions/doctor/index.ts";
import type { DoctorFileProbes, DoctorSnapshot } from "../src/extensions/doctor/types.ts";

function snapshot(overrides: Partial<DoctorSnapshot> = {}): DoctorSnapshot {
	return {
		platform: "linux",
		cwd: "/repo",
		env: { PATH: "/usr/bin" },
		settingsErrors: [],
		availableModelCount: 1,
		currentModel: { provider: "test", id: "model", hasConfiguredAuth: true },
		registeredTools: ["read", "bash", "edit", "write", "grep"],
		activeTools: ["read", "bash", "edit", "write", "grep"],
		paths: {
			settings: "/home/test/.pi/agent/settings.json",
			projectSettings: "/repo/.pi/settings.json",
			models: "/home/test/.pi/agent/models.json",
			auth: "/home/test/.pi/agent/auth.json",
		},
		configFiles: { settings: true, projectSettings: false, models: true, auth: true },
		isBunBinary: false,
		...overrides,
	};
}

const fileProbes: DoctorFileProbes = {
	fileExists: (candidate) => candidate === "/usr/bin/bash",
	isExecutable: (candidate) => candidate === "/usr/bin/bash",
};

interface Harness {
	runDoctor?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	registerTool: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	context: ExtensionCommandContext;
}

function createHarness(collectSnapshot: () => DoctorSnapshot): Harness {
	let runDoctor: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const registerTool = vi.fn();
	const setStatus = vi.fn();
	const notify = vi.fn();
	const api = {
		registerTool,
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			if (name === "doctor") runDoctor = options.handler;
		},
	} as unknown as ExtensionAPI;
	createDoctorExtension({ collectSnapshot, probes: fileProbes })(api);
	const context = { ui: { setStatus, notify } } as unknown as ExtensionCommandContext;
	return { registerTool, setStatus, notify, context, ...(runDoctor === undefined ? {} : { runDoctor }) };
}

describe("doctor extension", () => {
	it("collects the real command snapshot without reading credential contents", async () => {
		const agentDir = mkdtempSync(path.join(tmpdir(), "pi-doctor-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		let runDoctor: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const notify = vi.fn();
		const api = {
			registerCommand: (
				name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) => {
				if (name === "doctor") runDoctor = options.handler;
			},
			getAllTools: () => ["read", "bash", "edit", "write", "grep"].map((name) => ({ name })),
			getActiveTools: () => ["read", "bash", "edit", "write", "grep"],
		} as unknown as ExtensionAPI;
		const context = {
			cwd: agentDir,
			model: undefined,
			modelRegistry: {
				getError: () => undefined,
				getAvailable: () => [],
			},
			isProjectTrusted: () => false,
			ui: { setStatus: vi.fn(), notify },
		} as unknown as ExtensionCommandContext;
		try {
			createDoctorExtension({ probes: fileProbes })(api);
			await runDoctor?.("", context);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining(path.join(agentDir, "auth.json")), "error");
			expect(notify.mock.calls.flat().join(" ")).not.toContain("api_key");
		} finally {
			vi.unstubAllEnvs();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("registers only a user command and reports healthy state", async () => {
		const harness = createHarness(() => snapshot());

		await harness.runDoctor?.("", harness.context);

		expect(harness.registerTool).not.toHaveBeenCalled();
		expect(harness.setStatus.mock.calls).toEqual([
			["doctor", "正在检查运行环境…"],
			["doctor", undefined],
		]);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("Pi 健康检查"), "info");
	});

	it("uses error notification for blocking findings", async () => {
		const harness = createHarness(() => snapshot({ availableModelCount: 0, currentModel: undefined }));

		await harness.runDoctor?.("", harness.context);

		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("当前没有可用模型"), "error");
		expect(harness.setStatus).toHaveBeenLastCalledWith("doctor", undefined);
	});

	it("isolates unexpected collection errors and always clears status", async () => {
		const harness = createHarness(() => {
			throw new Error("snapshot failed sk-super-secret-value");
		});

		await harness.runDoctor?.("", harness.context);

		expect(harness.notify).toHaveBeenCalledWith("健康检查失败：snapshot failed [已隐藏]", "error");
		expect(harness.setStatus).toHaveBeenLastCalledWith("doctor", undefined);
	});
});
