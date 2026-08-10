import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { type SandboxController, sandboxController } from "./controller.ts";

export interface SandboxSpawnOptions extends SpawnOptions {
	cwd: string;
}

export type SandboxSpawnImplementation = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

export async function spawnSandboxedProcess(
	command: string,
	args: readonly string[],
	options: SandboxSpawnOptions,
	controller: SandboxController = sandboxController,
	spawn: SandboxSpawnImplementation = nodeSpawn,
): Promise<ChildProcess> {
	if (options.shell) throw new Error("Sandboxed processes require direct argv execution.");
	const prepared = await controller.prepare({
		command,
		args: [...args],
		cwd: options.cwd,
		env: options.env,
		...(options.signal ? { signal: options.signal } : {}),
	});
	return spawn(prepared.command, prepared.args, {
		...options,
		cwd: prepared.cwd,
		env: prepared.env,
		shell: false,
	});
}
