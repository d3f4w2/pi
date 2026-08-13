import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BackgroundProcessManager } from "../src/extensions/process/manager.ts";

const managers: BackgroundProcessManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
});

function manager(): BackgroundProcessManager {
	const instance = new BackgroundProcessManager();
	managers.push(instance);
	return instance;
}

describe("background process manager", () => {
	test("starts directly and returns cursor-based incremental logs", async () => {
		const service = manager();
		const startedAt = Date.now();
		const processInfo = await service.start(
			{
				command: process.execPath,
				args: [
					"-e",
					"console.log('ready'); setTimeout(() => console.log('later'), 120); setInterval(() => {}, 1000)",
				],
				cwd: process.cwd(),
				label: "test server",
			},
			process.cwd(),
		);

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(processInfo).toMatchObject({ id: "proc-1", label: "test server", state: "running" });
		await expect.poll(async () => (await service.logs(processInfo.id)).text).toContain("[stdout] ready");
		const first = await service.logs(processInfo.id);
		await expect
			.poll(async () => (await service.logs(processInfo.id, first.nextCursor)).text)
			.toContain("[stdout] later");
		const next = await service.logs(processInfo.id, first.nextCursor);
		expect(next.text).not.toContain("ready");
	});

	test("sends bounded input to a running managed process", async () => {
		const service = manager();
		const processInfo = await service.start(
			{
				command: process.execPath,
				args: [
					"-e",
					"process.stdin.setEncoding('utf8'); process.stdin.on('data', value => console.log('echo:' + value.trim()))",
				],
				cwd: process.cwd(),
			},
			process.cwd(),
		);

		await service.input(processInfo.id, "hello\n");
		await expect.poll(async () => (await service.logs(processInfo.id)).text).toContain("echo:hello");
		await expect(service.input(processInfo.id, "x".repeat(64 * 1024 + 1))).rejects.toThrow("过长");
	});

	test("stops and restarts only a process owned by this manager", async () => {
		const service = manager();
		const processInfo = await service.start(
			{ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: process.cwd() },
			process.cwd(),
		);
		const firstPid = processInfo.pid;

		expect(await service.stop(processInfo.id)).toMatchObject({ id: processInfo.id, state: "stopped" });
		const restarted = await service.restart(processInfo.id);
		expect(restarted).toMatchObject({ id: processInfo.id, state: "running" });
		expect(restarted.pid).not.toBe(firstPid);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await service.status(processInfo.id))[0]?.state).toBe("running");
		await expect(service.stop("proc-999")).rejects.toThrow("不存在");
	});

	test("rejects working directories outside the current project", async () => {
		const service = manager();
		await expect(
			service.start(
				{ command: process.execPath, args: ["-e", "console.log('no')"], cwd: path.resolve(process.cwd(), "..") },
				process.cwd(),
			),
		).rejects.toThrow("当前项目");
	});

	test("bounds retained and returned output", async () => {
		const service = manager();
		const processInfo = await service.start(
			{
				command: process.execPath,
				args: ["-e", "process.stdout.write('x'.repeat(400000))"],
				cwd: process.cwd(),
			},
			process.cwd(),
		);
		await expect.poll(async () => (await service.status(processInfo.id))[0]?.state).toBe("exited");

		const logs = await service.logs(processInfo.id, 0);
		expect(Buffer.byteLength(logs.text)).toBeLessThanOrEqual(24 * 1024 + 100);
		expect(logs.truncated).toBe(true);
	});
});
