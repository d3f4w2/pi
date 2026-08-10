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

export interface BrowserDevToolsTarget {
	id: string;
	type: string;
	url: string;
	title: string;
	websocketUrl: string;
}

export interface BrowserLaunchHandle {
	websocketUrl: string;
	initialTargetId: string;
	devtoolsUrl: string;
	browserName: string;
	isolated: boolean;
	listTargets(signal?: AbortSignal): Promise<BrowserDevToolsTarget[]>;
	newTarget(url: string, signal?: AbortSignal): Promise<BrowserDevToolsTarget>;
	activateTarget(id: string, signal?: AbortSignal): Promise<void>;
	closeTarget(id: string, signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
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

export function parseExplicitCdpEndpoint(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("PI_BROWSER_CDP_URL must be a valid loopback HTTP endpoint.");
	}
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(host)) {
		throw new Error("PI_BROWSER_CDP_URL only accepts an explicit loopback HTTP endpoint.");
	}
	if (url.username || url.password) throw new Error("PI_BROWSER_CDP_URL cannot contain credentials.");
	return url.origin;
}

function ensureSafeProfilePath(profileDir: string): void {
	const temporaryRoot = path.resolve(tmpdir());
	const resolved = path.resolve(profileDir);
	const relative = path.relative(temporaryRoot, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith(PROFILE_PREFIX)) {
		throw new Error("Browser profile path is outside the temporary isolated area.");
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
		if (signal?.aborted)
			throw signal.reason instanceof Error ? signal.reason : new Error("Browser startup canceled.");
		const spawnError = getSpawnError();
		if (spawnError) throw new Error(spawnError);
		if (child.exitCode !== null) throw new Error(getStderr() || `Browser exited during startup: ${child.exitCode}`);
		try {
			const port = Number.parseInt((await readFile(activePortFile, "utf8")).split(/\r?\n/, 1)[0] ?? "", 10);
			if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		await delay(50);
	}
	throw new Error("Browser startup exceeded 10 seconds.");
}

function targetFrom(value: unknown): BrowserDevToolsTarget | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.webSocketDebuggerUrl !== "string")
		return undefined;
	return {
		id: value.id,
		type: typeof value.type === "string" ? value.type : "page",
		url: typeof value.url === "string" ? value.url : "",
		title: typeof value.title === "string" ? value.title : "",
		websocketUrl: value.webSocketDebuggerUrl,
	};
}

async function requestJson(
	endpoint: string,
	pathname: string,
	method: "GET" | "PUT",
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await request(`${endpoint}${pathname}`, {
		method,
		headersTimeout: 2_000,
		bodyTimeout: 2_000,
		...(signal ? { signal } : {}),
	});
	if (response.statusCode < 200 || response.statusCode >= 300) {
		await response.body.dump();
		throw new Error(`Browser DevTools endpoint failed: HTTP ${response.statusCode}`);
	}
	const text = await response.body.text();
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

async function listTargets(endpoint: string, signal?: AbortSignal): Promise<BrowserDevToolsTarget[]> {
	const value = await requestJson(endpoint, "/json/list", "GET", signal);
	return Array.isArray(value)
		? value.flatMap((item) => {
				const target = targetFrom(item);
				return target?.type === "page" ? [target] : [];
			})
		: [];
}

async function firstTarget(endpoint: string, signal?: AbortSignal): Promise<BrowserDevToolsTarget> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const target = (await listTargets(endpoint, signal))[0];
			if (target) return target;
		} catch {}
		await delay(50);
	}
	throw new Error("Browser did not create a controllable page.");
}

function handleFor(options: {
	endpoint: string;
	initial: BrowserDevToolsTarget;
	browserName: string;
	isolated: boolean;
	close: () => Promise<void>;
}): BrowserLaunchHandle {
	return {
		websocketUrl: options.initial.websocketUrl,
		initialTargetId: options.initial.id,
		devtoolsUrl: options.endpoint,
		browserName: options.browserName,
		isolated: options.isolated,
		listTargets: (signal) => listTargets(options.endpoint, signal),
		newTarget: async (url, signal) => {
			const value = await requestJson(options.endpoint, `/json/new?${encodeURIComponent(url)}`, "PUT", signal);
			const target = targetFrom(value);
			if (!target) throw new Error("Browser returned an invalid new tab target.");
			return target;
		},
		activateTarget: async (id, signal) => {
			await requestJson(options.endpoint, `/json/activate/${encodeURIComponent(id)}`, "PUT", signal);
		},
		closeTarget: async (id, signal) => {
			await requestJson(options.endpoint, `/json/close/${encodeURIComponent(id)}`, "PUT", signal);
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline) {
				if (!(await listTargets(options.endpoint, signal)).some((target) => target.id === id)) return;
				await delay(25);
			}
			throw new Error(`Browser tab did not close: ${id}`);
		},
		close: options.close,
	};
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
		spawnError = error.code === "ENOENT" ? `Browser executable not found: ${command}` : error.message;
	});
	try {
		const port = await waitForDevToolsPort(
			profileDir,
			child,
			() => spawnError,
			() => stderr.trim(),
			signal,
		);
		const endpoint = `http://127.0.0.1:${port}`;
		const initial = await firstTarget(endpoint, signal);
		let closed = false;
		return handleFor({
			endpoint,
			initial,
			browserName: path.basename(command),
			isolated: true,
			close: async () => {
				if (closed) return;
				closed = true;
				await stopBrowserProcess(child);
				await cleanupProfile(profileDir);
			},
		});
	} catch (error) {
		await stopBrowserProcess(child);
		await cleanupProfile(profileDir);
		throw error;
	}
}

async function connectExplicit(endpointValue: string, signal?: AbortSignal): Promise<BrowserLaunchHandle> {
	const endpoint = parseExplicitCdpEndpoint(endpointValue);
	let initial: BrowserDevToolsTarget | undefined = (await listTargets(endpoint, signal))[0];
	if (!initial) {
		const value = await requestJson(endpoint, `/json/new?${encodeURIComponent("about:blank")}`, "PUT", signal);
		initial = targetFrom(value);
	}
	if (!initial) throw new Error("Explicit Chrome endpoint has no controllable page target.");
	return handleFor({ endpoint, initial, browserName: "explicit-chrome", isolated: false, close: async () => {} });
}

export async function launchBrowser(signal?: AbortSignal): Promise<BrowserLaunchHandle> {
	const explicit = process.env.PI_BROWSER_CDP_URL?.trim();
	if (explicit) return connectExplicit(explicit, signal);
	const errors: string[] = [];
	for (const candidate of browserExecutableCandidates()) {
		try {
			return await launchCandidate(candidate, signal);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(
		`No controllable Chrome, Edge, or Chromium was found.${errors.length > 0 ? `\n${errors.at(-1)}` : ""}`,
	);
}
