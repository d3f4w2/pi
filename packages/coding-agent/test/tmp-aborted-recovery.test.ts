import { describe, expect, it } from "vitest";
import { RecoveredFailureTracker } from "../src/extensions/evals/failure-tracker.ts";

function tool(toolName: string, isError: boolean, details: unknown = {}, input: Record<string, unknown> = {}) {
	return { toolName, isError, details, input };
}

describe("aborted recovery tracking", () => {
	it("does not carry an earlier failure through a later user abort", () => {
		const tracker = new RecoveredFailureTracker();
		tracker.start(1_000);
		tracker.recordTool(tool("verify", false, { passed: false }));
		tracker.recordTurn("error");
		expect(tracker.finish(2_000)).toBeUndefined();

		tracker.start(3_000);
		tracker.recordTurn("aborted");
		expect(tracker.finish(4_000)).toBeUndefined();

		tracker.start(5_000);
		tracker.recordTool(tool("edit", false, {}, { path: "src/recovery.ts" }));
		tracker.recordTool(tool("verify", false, { passed: true }));
		tracker.recordTurn("stop");
		expect(tracker.finish(6_000)).toBeUndefined();
	});
});
