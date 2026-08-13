import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CiCommandDependencies, parseCiArguments, runCiCommand } from "../src/cli/ci-command.ts";
import type { CiReceiptFile } from "../src/cli/ci-files.ts";
import { createTestRunReceiptEnvelope } from "./fixtures/run-receipt.ts";

function harness(
	options: {
		receiptText?: string;
		policyText?: string;
		automaticPolicy?: boolean;
		receiptDirectoryExists?: boolean;
		workspaceError?: Error;
		files?: CiReceiptFile[];
	} = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	const files: CiReceiptFile[] = options.files ?? [
		{ absolutePath: "/repo/run.json", displayPath: "run.json", modifiedMs: 1 },
	];
	const discoverReceiptFiles = vi.fn(async () => files);
	const readTextFile = vi.fn(async (filePath: string) =>
		filePath.endsWith("pigo.ci.json")
			? (options.policyText ?? '{"version":1}')
			: (options.receiptText ?? JSON.stringify(createTestRunReceiptEnvelope())),
	);
	const pathExists = vi.fn(async (filePath: string) => {
		if (filePath === "/receipts/current") return options.receiptDirectoryExists !== false;
		return options.automaticPolicy === true && filePath.endsWith("pigo.ci.json");
	});
	const getWorkspaceRoot = vi.fn(async () => {
		if (options.workspaceError) throw options.workspaceError;
		return "/repo";
	});
	const defaultReceiptDirectory = vi.fn(() => "/receipts/current");
	const dependencies: CiCommandDependencies = {
		cwd: () => "/repo",
		readTextFile,
		pathExists,
		getWorkspaceRoot,
		defaultReceiptDirectory,
		discoverReceiptFiles,
		writeStdout: (value) => stdout.push(value),
		writeStderr: (value) => stderr.push(value),
		setExitCode: (value) => exitCodes.push(value),
	};
	return {
		dependencies,
		defaultReceiptDirectory,
		discoverReceiptFiles,
		getWorkspaceRoot,
		readTextFile,
		stdout,
		stderr,
		exitCodes,
	};
}

describe("pigo ci command", () => {
	it("emits a stable passing JSON report", async () => {
		const test = harness();

		const exitCode = await runCiCommand(["run.json", "--json"], test.dependencies);

		expect(exitCode).toBe(0);
		expect(test.exitCodes).toEqual([0]);
		const report = JSON.parse(test.stdout.join(""));
		expect(report).toMatchObject({ schemaVersion: 1, passed: true, summary: { receipts: 1, passed: 1 } });
		expect(report.policy.source).toBe("built-in:strict-v1");
		expect(test.getWorkspaceRoot).not.toHaveBeenCalled();
	});

	it("checks only the latest stored receipt when no input is provided", async () => {
		const test = harness({
			files: [
				{ absolutePath: "/receipts/current/old.json", displayPath: "old.json", modifiedMs: 1 },
				{ absolutePath: "/receipts/current/new.json", displayPath: "new.json", modifiedMs: 2 },
			],
		});

		const exitCode = await runCiCommand(["--json"], test.dependencies);

		expect(exitCode).toBe(0);
		expect(test.getWorkspaceRoot).toHaveBeenCalledWith("/repo");
		expect(test.defaultReceiptDirectory).toHaveBeenCalledWith("/repo");
		expect(test.discoverReceiptFiles).toHaveBeenCalledWith(["/receipts/current"], "/repo");
		const report = JSON.parse(test.stdout.join(""));
		expect(report.summary.receipts).toBe(1);
		expect(report.receipts[0].file).toBe("new.json");
	});

	it("checks every stored project receipt with --all", async () => {
		const test = harness({
			files: [
				{ absolutePath: "/receipts/current/a.json", displayPath: "a.json", modifiedMs: 1 },
				{ absolutePath: "/receipts/current/b.json", displayPath: "b.json", modifiedMs: 2 },
			],
		});

		const exitCode = await runCiCommand(["--all", "--json"], test.dependencies);

		expect(exitCode).toBe(0);
		expect(JSON.parse(test.stdout.join("")).summary.receipts).toBe(2);
	});

	it("explains how to create the first receipt", async () => {
		const test = harness({ receiptDirectoryExists: false });

		const exitCode = await runCiCommand([], test.dependencies);

		expect(exitCode).toBe(2);
		expect(test.discoverReceiptFiles).not.toHaveBeenCalled();
		expect(test.stderr.join("")).toContain('Run pigo run "<task>" first');
	});

	it("explains how to use zero-input mode outside a Git project", async () => {
		const test = harness({ workspaceError: new Error("not a Git work tree") });

		const exitCode = await runCiCommand([], test.dependencies);

		expect(exitCode).toBe(2);
		expect(test.discoverReceiptFiles).not.toHaveBeenCalled();
		expect(test.stderr.join("")).toContain("Run pigo ci inside a Git project or pass a receipt path");
	});

	it("automatically loads pigo.ci.json for the current project", async () => {
		const test = harness({ automaticPolicy: true });

		const exitCode = await runCiCommand(["--json"], test.dependencies);

		expect(exitCode).toBe(0);
		expect(JSON.parse(test.stdout.join("")).policy.source).toBe("pigo.ci.json");
		expect(test.readTextFile).toHaveBeenCalledWith(path.join("/repo", "pigo.ci.json"));
	});

	it("keeps a tampered receipt in the report and fails the gate", async () => {
		const envelope = createTestRunReceiptEnvelope();
		envelope.receipt.durationMs = 9999;
		const test = harness({ receiptText: JSON.stringify(envelope) });

		const exitCode = await runCiCommand(["run.json", "--json"], test.dependencies);

		expect(exitCode).toBe(1);
		const report = JSON.parse(test.stdout.join(""));
		expect(report.receipts[0]).toMatchObject({ valid: false, passed: false });
		expect(report.receipts[0].violations[0].code).toBe("receipt.invalid");
	});

	it("returns invocation error 2 for an invalid policy before discovery", async () => {
		const test = harness({ policyText: '{"version":2}' });

		const exitCode = await runCiCommand(["run.json", "--policy", "pigo.ci.json"], test.dependencies);

		expect(exitCode).toBe(2);
		expect(test.discoverReceiptFiles).not.toHaveBeenCalled();
		expect(test.stderr.join("")).toContain("version must be 1");
	});

	it("shows help without requiring receipt inputs", async () => {
		const test = harness();

		const exitCode = await runCiCommand(["--help"], test.dependencies);

		expect(exitCode).toBe(0);
		expect(test.discoverReceiptFiles).not.toHaveBeenCalled();
		expect(test.stdout.join("")).toContain("pigo ci [receipt-or-directory");
	});

	it("rejects --all with explicit receipt inputs", async () => {
		const test = harness();

		const exitCode = await runCiCommand(["run.json", "--all"], test.dependencies);

		expect(exitCode).toBe(2);
		expect(test.discoverReceiptFiles).not.toHaveBeenCalled();
		expect(test.stderr.join("")).toContain("cannot be combined");
	});

	it("rejects unknown options", () => {
		expect(() => parseCiArguments(["--unknown"])).toThrow(/Unknown option/);
	});
});
