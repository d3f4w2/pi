import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentChild, executeVerifyChild } from "../src/cli/run-command.ts";
import type { EffectiveRunContract } from "../src/cli/run-contract.ts";

const temporaryDirectories: string[] = [];

function contract(overrides: Partial<EffectiveRunContract["budget"]> = {}): EffectiveRunContract {
	return {
		version: 1,
		task: "private task over stdin",
		scope: ["."],
		verification: [],
		budget: { timeoutSeconds: 5, maxTokens: 1000, maxToolCalls: 10, ...overrides },
	};
}

async function childScript(source: string): Promise<{ directory: string; entryPath: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), "pigo-run-child-"));
	temporaryDirectories.push(directory);
	const entryPath = path.join(directory, "child.mjs");
	await writeFile(entryPath, source, "utf8");
	return { directory, entryPath };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("pigo run child controller", () => {
	it("sends the private task over stdin and parses a successful event stream", async () => {
		const fixture = await childScript(`
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.argv.includes(input)) process.exit(9);
console.log(JSON.stringify({ type: "session", version: 3 }));
console.log(JSON.stringify({ type: "message_end", message: {
  role: "assistant", provider: "faux", model: "test", stopReason: "stop",
  content: [{ type: "text", text: input === "private task over stdin" ? "ok" : "bad input" }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }
}}));
console.log(JSON.stringify({ type: "turn_end", message: {
  role: "assistant", provider: "faux", model: "test", stopReason: "stop", content: [],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }
}, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
`);

		const result = await executeAgentChild(contract(), ["--model", "faux/test"], fixture.directory, {
			entryPath: fixture.entryPath,
			execArgv: [],
		});

		expect(result.exitCode).toBe(0);
		expect(result.terminationReason).toBe("completed");
		expect(result.summary.finalResponse).toBe("ok");
		expect(result.summary.usage.totalTokens).toBe(2);
	});

	it("marks tool-call and protocol budget failures even when the child exits quickly", async () => {
		const toolFixture = await childScript(`
process.stdin.resume();
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} }));
setTimeout(() => process.exit(0), 25);
`);
		const toolResult = await executeAgentChild(contract({ maxToolCalls: 1 }), [], toolFixture.directory, {
			entryPath: toolFixture.entryPath,
			execArgv: [],
		});
		expect(toolResult.terminationReason).toBe("tool_budget");

		const protocolFixture = await childScript(`
process.stdin.resume();
console.log("not-json and private");
setTimeout(() => process.exit(0), 25);
`);
		const protocolResult = await executeAgentChild(contract(), [], protocolFixture.directory, {
			entryPath: protocolFixture.entryPath,
			execArgv: [],
		});
		expect(protocolResult.terminationReason).toBe("protocol_error");
		expect(JSON.stringify(protocolResult.summary)).not.toContain("not-json and private");
	});

	it("runs independent verification in a separate worker process", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pigo-run-verify-"));
		temporaryDirectories.push(directory);
		await writeFile(
			path.join(directory, "package.json"),
			JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }),
			"utf8",
		);

		const result = await executeVerifyChild({ operation: "typecheck", path: ".", timeoutSeconds: 10 }, directory);

		expect(result.details.passed).toBe(true);
		expect(result.details.checks).toEqual([expect.objectContaining({ id: "typecheck", status: "passed" })]);
	});
});
