import path from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspaceReceiptPath, getWorkspaceRunDirectory, hashWorkspaceRoot } from "../src/cli/project-runs.ts";

describe("project-scoped run paths", () => {
	it("normalizes Windows roots before hashing", () => {
		expect(hashWorkspaceRoot("D:\\Work\\Pigo", "win32")).toBe(hashWorkspaceRoot("d:/work/pigo/", "win32"));
	});

	it("keeps distinct workspaces in distinct private directories", () => {
		const first = getWorkspaceRunDirectory("C:\\Users\\dev\\.pigo\\agent", "D:\\work\\first", "win32");
		const second = getWorkspaceRunDirectory("C:\\Users\\dev\\.pigo\\agent", "D:\\work\\second", "win32");

		expect(first).not.toBe(second);
		expect(first).not.toContain("work\\first");
		expect(first).not.toContain("work/first");
		expect(path.basename(first)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("uses the run ID only as the receipt filename", () => {
		const directory = getWorkspaceRunDirectory("/state", "/repo", "linux");
		const receipt = getWorkspaceReceiptPath("/state", "/repo", "run-123", "linux");

		expect(receipt).toBe(path.join(directory, "run-123.json"));
	});
});
