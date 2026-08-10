export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	type InternalReadResource,
	type InternalReadResourceContext,
	type InternalReadResourceResolver,
	type ReadSourceDetails,
	registerInternalReadResourceResolver,
} from "./unified-read.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { checkDefaultSandboxPath, ensureDefaultSandbox } from "../sandbox/default.ts";
import { type BashToolOptions, createBashToolDefinition } from "./bash.ts";
import { createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { resolveToCwd } from "./path-utils.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

function guardToolDefinition(tool: ToolDef, cwd: string): ToolDef {
	const access = tool.name === "write" || tool.name === "edit" ? "write" : tool.name === "bash" ? undefined : "read";
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		async execute(toolCallId, input, signal, onUpdate, context) {
			if (access) {
				const candidate = input as { path?: unknown };
				const requestedPath = typeof candidate.path === "string" ? candidate.path : ".";
				const sourcePath = requestedPath.split("!/")[0] ?? requestedPath;
				const isResourceUri = /^[a-z][a-z\d+.-]*:\/\//i.test(sourcePath);
				if (!isResourceUri) await checkDefaultSandboxPath(cwd, resolveToCwd(sourcePath, cwd), access);
				else if (sourcePath.toLowerCase().startsWith("file://")) {
					await checkDefaultSandboxPath(cwd, fileURLToPath(new URL(sourcePath)), access);
				}
			} else await ensureDefaultSandbox(cwd);
			return execute(toolCallId, input, signal, onUpdate, context);
		},
	};
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	let definition: ToolDef;
	switch (toolName) {
		case "read":
			definition = createReadToolDefinition(cwd, options?.read);
			break;
		case "bash":
			definition = createBashToolDefinition(cwd, options?.bash);
			break;
		case "edit":
			definition = createEditToolDefinition(cwd, options?.edit);
			break;
		case "write":
			definition = createWriteToolDefinition(cwd, options?.write);
			break;
		case "grep":
			definition = createGrepToolDefinition(cwd, options?.grep);
			break;
		case "find":
			definition = createFindToolDefinition(cwd, options?.find);
			break;
		case "ls":
			definition = createLsToolDefinition(cwd, options?.ls);
			break;
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
	return guardToolDefinition(definition, cwd);
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	return wrapToolDefinition(createToolDefinition(toolName, cwd, options));
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createToolDefinition("read", cwd, options),
		createToolDefinition("bash", cwd, options),
		createToolDefinition("edit", cwd, options),
		createToolDefinition("write", cwd, options),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createToolDefinition("read", cwd, options),
		createToolDefinition("grep", cwd, options),
		createToolDefinition("find", cwd, options),
		createToolDefinition("ls", cwd, options),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createToolDefinition("read", cwd, options),
		bash: createToolDefinition("bash", cwd, options),
		edit: createToolDefinition("edit", cwd, options),
		write: createToolDefinition("write", cwd, options),
		grep: createToolDefinition("grep", cwd, options),
		find: createToolDefinition("find", cwd, options),
		ls: createToolDefinition("ls", cwd, options),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createTool("read", cwd, options),
		createTool("bash", cwd, options),
		createTool("edit", cwd, options),
		createTool("write", cwd, options),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createTool("read", cwd, options),
		createTool("grep", cwd, options),
		createTool("find", cwd, options),
		createTool("ls", cwd, options),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createTool("read", cwd, options),
		bash: createTool("bash", cwd, options),
		edit: createTool("edit", cwd, options),
		write: createTool("write", cwd, options),
		grep: createTool("grep", cwd, options),
		find: createTool("find", cwd, options),
		ls: createTool("ls", cwd, options),
	};
}
