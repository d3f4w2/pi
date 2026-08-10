import type { AgentEvalCase } from "./types.ts";

const scopeFiles: Record<string, string> = {
	"package.json": '{"type":"module"}\n',
	"src/target.mjs": "export function combine(a, b) { return a * b; }\n",
};
for (let index = 1; index <= 20; index++) {
	scopeFiles[`src/archive/module-${index}.mjs`] = `export const archivedValue${index} = ${index};\n`;
}

export const AGENT_EVAL_CASES: readonly AgentEvalCase[] = [
	{
		id: "navigation-find-definition",
		title: "找到真实定义",
		category: "navigation",
		task: '找到 createClient 实际调用的 normalizeEndpoint 定义。不要修改源码；在项目根目录创建 answer.json，内容必须是 {"file":"相对路径","symbol":"导出名"}。',
		publicFiles: {
			"package.json": '{"type":"module"}\n',
			"src/client.mjs":
				'import { normalizeEndpoint } from "./internal/url-tools.mjs";\nexport function createClient(url) { return { endpoint: normalizeEndpoint(url) }; }\n',
			"src/internal/url-tools.mjs":
				'export function normalizeEndpoint(value) { return value.trim().replace(/\\/$/, ""); }\n',
			"src/internal/retry.mjs": "export const normalizeDelay = (value) => Math.max(0, value);\n",
		},
		hiddenFiles: {
			".pi-eval-hidden/verify.test.mjs":
				'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\ntest("located definition", async () => { const answer = JSON.parse(await readFile(new URL("../answer.json", import.meta.url), "utf8")); assert.deepEqual(answer, { file: "src/internal/url-tools.mjs", symbol: "normalizeEndpoint" }); });\n',
		},
		timeoutMs: 120_000,
		maxOutputTokens: 4_000,
		maxToolCalls: 12,
	},
	{
		id: "bug-fix-cart-total",
		title: "修复购物车总价",
		category: "bug_fix",
		task: "修复 calculateTotal：每项价格必须乘以数量。保持现有导出不变，并验证修改。",
		publicFiles: {
			"package.json": '{"type":"module"}\n',
			"src/cart.mjs":
				"export function calculateTotal(items) { return items.reduce((sum, item) => sum + item.price, 0); }\n",
		},
		hiddenFiles: {
			".pi-eval-hidden/verify.test.mjs":
				'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { calculateTotal } from "../src/cart.mjs";\ntest("uses quantity", () => { assert.equal(calculateTotal([{ price: 8, quantity: 3 }, { price: 2, quantity: 2 }]), 28); assert.equal(calculateTotal([]), 0); });\n',
		},
		timeoutMs: 120_000,
		maxOutputTokens: 6_000,
		maxToolCalls: 16,
	},
	{
		id: "verification-run-tests",
		title: "修复并运行验证",
		category: "verification",
		task: "修复 slugify，使连续空白全部转换为单个连字符；运行项目已有测试确认通过。",
		publicFiles: {
			"package.json": '{"type":"module","scripts":{"test":"node --test"}}\n',
			"src/slug.mjs": 'export function slugify(value) { return value.trim().toLowerCase().replace(" ", "-"); }\n',
			"test/slug.test.mjs":
				'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../src/slug.mjs";\ntest("slug", () => assert.equal(slugify("Hello   Pi Go"), "hello-pi-go"));\n',
		},
		hiddenFiles: {
			".pi-eval-hidden/verify.test.mjs":
				'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../src/slug.mjs";\ntest("normalizes whitespace", () => { assert.equal(slugify("  A\\t B   C "), "a-b-c"); });\n',
		},
		timeoutMs: 120_000,
		maxOutputTokens: 6_000,
		maxToolCalls: 16,
	},
	{
		id: "recovery-wrong-file-hint",
		title: "路径错误后恢复",
		category: "recovery",
		task: "修复 src/settings.ts 中 loadSettings 的默认值问题：缺少 enabled 时应为 true。提示路径可能已经过时；遇到错误后请自行找到真实文件并完成验证。",
		publicFiles: {
			"package.json": '{"type":"module"}\n',
			"src/settings.mjs":
				'export function loadSettings(input = {}) { return { enabled: input.enabled ?? false, name: input.name ?? "default" }; }\n',
		},
		hiddenFiles: {
			".pi-eval-hidden/verify.test.mjs":
				'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { loadSettings } from "../src/settings.mjs";\ntest("defaults enabled", () => { assert.equal(loadSettings().enabled, true); assert.equal(loadSettings({ enabled: false }).enabled, false); });\n',
		},
		timeoutMs: 120_000,
		maxOutputTokens: 7_000,
		maxToolCalls: 18,
	},
	{
		id: "scope-control-target-only",
		title: "控制修改范围",
		category: "scope_control",
		task: "只修改 src/target.mjs：combine 应返回两个数的和。archive 目录与其他文件都不相关，不要读取或修改它们。完成后做最小验证。",
		publicFiles: scopeFiles,
		hiddenFiles: {
			".pi-eval-hidden/verify.test.mjs":
				'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport { combine } from "../src/target.mjs";\ntest("target fixed without collateral edits", async () => { assert.equal(combine(7, 5), 12); for (let index = 1; index <= 20; index++) assert.equal(await readFile(new URL("../src/archive/module-" + index + ".mjs", import.meta.url), "utf8"), "export const archivedValue" + index + " = " + index + ";\\n"); });\n',
		},
		timeoutMs: 120_000,
		maxOutputTokens: 4_000,
		maxToolCalls: 8,
	},
];
