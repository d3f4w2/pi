import { describe, expect, it } from "vitest";
import {
	createEffectiveRunContract,
	hashRunContract,
	parseRunArguments,
	parseRunContractText,
} from "../src/cli/run-contract.ts";

const ROOT = process.platform === "win32" ? "C:\\repo" : "/repo";

describe("pigo run contract", () => {
	it("creates a bounded default contract from an unquoted task", () => {
		const parsed = parseRunArguments(["fix", "the", "parser"]);
		const contract = createEffectiveRunContract(parsed, undefined, ROOT);

		expect(contract).toEqual({
			version: 1,
			task: "fix the parser",
			scope: ["."],
			verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
			budget: { timeoutSeconds: 1800, maxTokens: 200_000, maxToolCalls: 200 },
		});
	});

	it("parses repeated scopes, checks, budgets, output options, and forwarded agent arguments", () => {
		const parsed = parseRunArguments([
			"Fix parser",
			"--scope",
			"packages/parser/src",
			"--scope=packages/parser/test",
			"--verify",
			"typecheck:packages/parser",
			"--verify=test:packages/parser/test",
			"--timeout",
			"900",
			"--max-tokens=50000",
			"--max-tool-calls",
			"100",
			"--receipt",
			"artifacts/run.json",
			"--json",
			"--",
			"--model",
			"openai/gpt-5.6",
		]);
		const contract = createEffectiveRunContract(parsed, undefined, ROOT);

		expect(parsed.receiptPath).toBe("artifacts/run.json");
		expect(parsed.json).toBe(true);
		expect(parsed.forwardedArgs).toEqual(["--model", "openai/gpt-5.6"]);
		expect(contract.scope).toEqual(["packages/parser/src", "packages/parser/test"]);
		expect(contract.verification).toEqual([
			{ operation: "typecheck", path: "packages/parser", timeoutSeconds: 60 },
			{ operation: "test", path: "packages/parser/test", timeoutSeconds: 60 },
		]);
		expect(contract.budget).toEqual({ timeoutSeconds: 900, maxTokens: 50_000, maxToolCalls: 100 });
	});

	it("loads a strict versioned JSON contract and applies explicit CLI budget overrides", () => {
		const document = parseRunContractText(`{
			"version": 1,
			"task": "fix parser",
			"scope": ["src", "test"],
			"verification": [{"operation":"lint","path":"src","timeoutSeconds":30}],
			"budget": {"timeoutSeconds":600,"maxTokens":40000,"maxToolCalls":80}
		}`);
		const parsed = parseRunArguments(["--contract", "pigo.run.json", "--timeout", "120"]);
		const contract = createEffectiveRunContract(parsed, document, ROOT);

		expect(contract.task).toBe("fix parser");
		expect(contract.budget).toEqual({ timeoutSeconds: 120, maxTokens: 40_000, maxToolCalls: 80 });
	});

	it("supports explicitly disabling verification", () => {
		const parsed = parseRunArguments(["documentation only", "--verify", "none"]);
		const contract = createEffectiveRunContract(parsed, undefined, ROOT);

		expect(contract.verification).toEqual([]);
	});

	it("parses standalone receipt verification", () => {
		const parsed = parseRunArguments(["--check-receipt", "artifacts/run.json", "--json"]);

		expect(parsed.checkReceiptPath).toBe("artifacts/run.json");
		expect(parsed.json).toBe(true);
		expect(() => parseRunArguments(["task", "--check-receipt", "run.json"])).toThrow(/不能与/);
	});

	it.each([
		["unknown CLI option", ["task", "--verfy", "auto"]],
		["missing option value", ["task", "--scope"]],
		["invalid timeout", ["task", "--timeout", "0"]],
		["conflicting task sources", ["task", "--contract", "run.json"]],
		["forwarded print mode", ["task", "--", "--mode", "json"]],
		["forwarded prompt", ["task", "--", "-p", "other"]],
		["forwarded session", ["task", "--", "--session", "x"]],
	] as const)("rejects %s", (_label, args) => {
		expect(() => parseRunArguments([...args])).toThrow();
	});

	it("rejects unknown contract fields instead of weakening policy through typos", () => {
		expect(() => parseRunContractText('{"version":1,"task":"fix","scpoe":["src"]}')).toThrow(/scpoe/);
		expect(() =>
			parseRunContractText('{"version":1,"task":"fix","budget":{"timeoutSeconds":60,"maxToolCall":10}}'),
		).toThrow(/maxToolCall/);
	});

	it("rejects paths outside the workspace and normalizes safe paths", () => {
		const outside = parseRunArguments(["task", "--scope", "../secret"]);
		expect(() => createEffectiveRunContract(outside, undefined, ROOT)).toThrow(/工作区/);

		const inside = parseRunArguments(["task", "--scope", "src/../test"]);
		expect(createEffectiveRunContract(inside, undefined, ROOT).scope).toEqual(["test"]);
	});

	it("hashes the canonical effective contract deterministically", () => {
		const first = createEffectiveRunContract(parseRunArguments(["task", "--scope", "src"]), undefined, ROOT);
		const second = createEffectiveRunContract(parseRunArguments(["task", "--scope=src"]), undefined, ROOT);

		expect(hashRunContract(first)).toMatch(/^[a-f0-9]{64}$/);
		expect(hashRunContract(first)).toBe(hashRunContract(second));
		expect(hashRunContract({ ...second, task: "other" })).not.toBe(hashRunContract(first));
	});
});
