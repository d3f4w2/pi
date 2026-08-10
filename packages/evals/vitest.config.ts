import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			fileParallelism: false,
			include: ["src/**/*.eval.ts"],
			// Command harnesses enforce their own 120s default. Leave enough time to terminate,
			// collect filesystem assertions, and attach artifacts after a task-level timeout.
			testTimeout: 180000,
			hookTimeout: 30000,
			setupFiles: ["./src/vitest-evals/setup.ts"],
			reporters: ["vitest-evals/reporter", "./src/vitest-evals/reporter.ts"],
		},
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
	}),
);
