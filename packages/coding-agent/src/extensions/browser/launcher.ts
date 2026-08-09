import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "undici";
import { spawnProcess } from "../../utils/child-process.ts";
import { killProcessTree } from "../../utils/shell.ts";

const STARTUP_TIMEOUT_MS = 10_000;
const PROFILE_PREFIX = "pi-browser-";

export interface BrowserLaunchHandle {
	websocketUrl: string;
	browserName: string;
	close(): Promise<void>;
}

interface DevToolsTarget {
	type?: string;
	webSocketDebuggerUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function browserExecutableCandidates(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	fileExists: (candidate: string) => boolean = existsSync,
): string[] {
	const configured = environment.PI_BROWSER_EXECUTABLE?.trim();
	const absoluteCandidates: string[] = [];
	if (platform === "win32") {
		for (const root of [environment.ProgramFiles, environment["ProgramFiles(x86)"], environment.LOCALAPPDATA]) {
			if (!root) continue;
			absoluteCandidates.push(
				path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
				path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
				path.win32.join(root, "Chromium", "Application", "chrome.exe"),
			);
		}
	} else if (platform === "darwin") {
		absoluteCandidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		);
	}
	const fallbacks =
		platform === "win32"
			? ["msedge.exe", "chrome.exe", "chromium.exe"]
			: platform === "darwin"
				? ["google-chrome", "microsoft-edge", "chromium"]
				: ["google-chrome", "google-chrome-stable", "microsoft-edge", "chromium", "chromium-browser"];
	return [...new Set([...(configured ? [configured] : []), ...absoluteCandidates.filter(fileExists), ...fallbacks])];
}

function ensureSafeProfilePath(profileDir: string): void {
	const temporaryRoot = path.resolve(tmpdir());
	const resolved = path.resolve(profileDir);
	const relative = path.relative(temporaryRoot, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith(PROFILE_PREFIX)) {
		throw new Error("浏览器临时目录超出安全范围。");
	}
}

async function cleanupProfile(profileDir: string): Promise<void> {
	ensureSafeProfilePath(profileDir);
	await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopBrowserProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	if (child.pid === undefined) {
		if (!child.killed) child.kill();
		return;
	}
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	killProcessTree(child.pid);
	await Promise.race([exited, delay(3_000)]);
}

async function waitForDevToolsPort(
	profileDir: string,
	child: ChildProcess,
	getSpawnError: () => string,
	getStderr: () => string,
	signal?: AbortSignal,
): Promise<number> {
	const activePortFile = path.join(profileDir, "DevToolsActivePort");
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("浏览器启动已取消。");
		const spawnError = getSpawnError();
		if (spawnError) throw new Error(spawnError);
		if (child.exitCode !== null) throw new Error(getStderr() || `浏览器启动后立即退出：${child.exitCode}`);
		try {
			const port = Number.parseInt((await readFile(activePortFile, "utf8")).split(/\r?\n/, 1)[0] ?? "", 10);
			if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		await delay(50);
	}
	throw new Error("浏览器启动超过 10 秒。请检查浏览器安装或设置 PI_BROWSER_EXECUTABLE。");
}

async function pageWebSocketUrl(port: number, signal?: AbortSignal): Promise<string> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("浏览器启动已取消。");
		try {
			const response = await request(`http://127.0.0.1:${port}/json/list`, {
				method: "GET",
				headersTimeout: 1_000,
				bodyTimeout: 1_000,
			});
			const value: unknown = await response.body.json();
			if (Array.isArray(value)) {
				const page = value.find(
					(item): item is DevToolsTarget =>
						isRecord(item) && item.type === "page" && typeof item.webSocketDebuggerUrl === "string",
				);
				if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
			}
		} catch {
			// Browser HTTP endpoint may need another short startup interval.
		}
		await delay(50);
	}
	throw new Error("浏览器没有创建可控制的页面。");
}

async function launchCandidate(command: string, signal?: AbortSignal): Promise<BrowserLaunchHandle> {
	const profileDir = await mkdtemp(path.join(tmpdir(), PROFILE_PREFIX));
	let stderr = "";
	let spawnError = "";
	const child = spawnProcess(
		command,
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-extensions",
			"--disable-sync",
			"--metrics-recording-only",
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
	);
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-8_000);
	});
	child.once("error", (error: NodeJS.ErrnoException) => {
		spawnError = error.code === "ENOENT" ? `没有找到 ${command}` : error.message;
	});
	try {
		const port = await waitForDevToolsPort(
			profileDir,
			child,
			() => spawnError,
			() => stderr.trim(),
			signal,
		);
		const websocketUrl = await pageWebSocketUrl(port, signal);
		let closed = false;
		return {
			websocketUrl,
			browserName: path.basename(command),
			close: async () => {
				if (closed) return;
				closed = true;
				await stopBrowserProcess(child);
				await cleanupProfile(profileDir);
			},
		};
	} catch (error) {
		await stopBrowserProcess(child);
		await cleanupProfile(profileDir);
		throw error;
	}
}

export async function launchBrowser(signal?: AbortSignal): Promise<BrowserLaunchHandle> {
	const errors: string[] = [];
	for (const candidate of browserExecutableCandidates()) {
		try {
			return await launchCandidate(candidate, signal);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(
		`没有找到可控制的 Chrome、Edge 或 Chromium。请安装浏览器，或设置 PI_BROWSER_EXECUTABLE。${errors.length > 0 ? `\n${errors.at(-1)}` : ""}`,
	);
}
