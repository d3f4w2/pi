import assert from "node:assert/strict";
import test from "node:test";
import { parseStartupTimings } from "./profile-coding-agent-node.mjs";

test("parses named and legacy startup timing groups", () => {
	const timings = parseStartupTimings(`noise
--- Startup Timings: process ---
  module graph loaded: 1234.5ms
  TOTAL: 1234.5ms
--------------------------------

--- Startup Timings: main ---
  parseArgs: 2ms
  TOTAL: 2ms
------------------------------

--- Startup Timings ---
  legacy: 4ms
  TOTAL: 4ms
------------------------
noise`);

	assert.deepEqual([...timings], [
		["process.module graph loaded", 1234.5],
		["process.TOTAL", 1234.5],
		["main.parseArgs", 2],
		["main.TOTAL", 2],
		["startup.legacy", 4],
		["startup.TOTAL", 4],
	]);
});

test("does not merge labels from different timing namespaces", () => {
	const timings = parseStartupTimings(`--- Startup Timings: main ---
  load: 10ms
-----------------------------
--- Startup Timings: extensions ---
  load: 20ms
-----------------------------------`);

	assert.equal(timings.get("main.load"), 10);
	assert.equal(timings.get("extensions.load"), 20);
});
