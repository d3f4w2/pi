import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveNpmCliPath(options = {}) {
	const npmExecPath = Object.hasOwn(options, "npmExecPath") ? options.npmExecPath : process.env.npm_execpath;
	const nodeExecPath = options.nodeExecPath ?? process.execPath;
	const fileExists = options.fileExists ?? existsSync;
	const candidates = [
		npmExecPath,
		join(dirname(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js"),
	].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
	return candidates.find((candidate) => fileExists(candidate));
}
