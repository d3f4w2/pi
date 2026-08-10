import path from "node:path";

export interface SandboxProxyEnvironment {
	http: string;
	noProxy: string;
}

export interface CreateSandboxEnvironmentOptions {
	tempRoot: string;
	platform?: NodeJS.Platform;
	proxy?: SandboxProxyEnvironment;
}

const PASSTHROUGH_NAMES = [
	"CI",
	"COLORTERM",
	"COMSPEC",
	"FORCE_COLOR",
	"LANG",
	"LC_ALL",
	"NO_COLOR",
	"PATHEXT",
	"SystemRoot",
	"TERM",
	"TZ",
	"WINDIR",
] as const;

function stringValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = environment[name];
	return typeof value === "string" ? value : undefined;
}

export function createSandboxEnvironment(
	source: NodeJS.ProcessEnv,
	options: CreateSandboxEnvironmentOptions,
): NodeJS.ProcessEnv {
	const platform = options.platform ?? process.platform;
	const api = platform === "win32" ? path.win32 : path.posix;
	const sandboxHome = api.join(options.tempRoot, "home");
	const sandboxTemp = api.join(options.tempRoot, "tmp");
	const environment: NodeJS.ProcessEnv = {
		SANDBOX_RUNTIME: "1",
		HOME: sandboxHome,
		TMPDIR: sandboxTemp,
		TEMP: sandboxTemp,
		TMP: sandboxTemp,
		GIT_TERMINAL_PROMPT: "0",
		XDG_CACHE_HOME: api.join(options.tempRoot, "cache"),
		XDG_CONFIG_HOME: api.join(options.tempRoot, "config"),
		NPM_CONFIG_CACHE: api.join(options.tempRoot, "npm-cache"),
	};
	const executablePath = stringValue(source, "PATH") ?? stringValue(source, "Path");
	if (executablePath !== undefined) environment.PATH = executablePath;
	for (const name of PASSTHROUGH_NAMES) {
		const value = stringValue(source, name);
		if (value !== undefined) environment[name] = value;
	}
	for (const [name, value] of Object.entries(source)) {
		if (name.startsWith("LC_") && typeof value === "string") environment[name] = value;
	}
	if (platform === "win32") environment.USERPROFILE = sandboxHome;
	if (options.proxy) {
		environment.HTTP_PROXY = options.proxy.http;
		environment.HTTPS_PROXY = options.proxy.http;
		environment.http_proxy = options.proxy.http;
		environment.https_proxy = options.proxy.http;
		environment.NO_PROXY = options.proxy.noProxy;
		environment.no_proxy = options.proxy.noProxy;
	}
	return environment;
}
