import { describe, expect, it, vi } from "vitest";
import { runInteractiveCi } from "../src/extensions/goal-loop/ci.ts";

describe("interactive goal-loop CI façade", () => {
	it("passes quoted CLI arguments to the existing offline CI command and captures its report", async () => {
		const runner = vi.fn(async (args, dependencies) => {
			expect(args).toEqual(["receipts/a b.json", "--policy", "strict policy.json"]);
			expect(dependencies.cwd()).toBe("C:/repo");
			dependencies.writeStdout("Pigo CI gate: PASS\n");
			dependencies.setExitCode(0);
			return 0;
		});

		const result = await runInteractiveCi('"receipts/a b.json" --policy "strict policy.json"', "C:/repo", runner);

		expect(result).toEqual({ exitCode: 0, stdout: "Pigo CI gate: PASS\n", stderr: "" });
		expect(runner).toHaveBeenCalledOnce();
	});

	it("returns invocation errors without starting another subsystem", async () => {
		const runner = vi.fn(async (_args, dependencies) => {
			dependencies.writeStderr("pigo ci: no receipt\n");
			dependencies.setExitCode(2);
			return 2;
		});

		expect(await runInteractiveCi("", "C:/repo", runner)).toEqual({
			exitCode: 2,
			stdout: "",
			stderr: "pigo ci: no receipt\n",
		});
	});
});
