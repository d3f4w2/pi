import { APP_NAME, VERSION } from "./build-info.ts";

interface BootstrapDependencies {
	configureHttpDispatcher: () => void;
	runMain: (args: string[]) => Promise<void>;
	writeVersion: (version: string) => void;
}

async function loadBootstrapDependencies(): Promise<Omit<BootstrapDependencies, "writeVersion">> {
	const [httpDispatcherModule, mainModule] = await Promise.all([
		import("./core/http-dispatcher.ts"),
		import("./main.ts"),
	]);
	return {
		configureHttpDispatcher: httpDispatcherModule.configureHttpDispatcher,
		runMain: mainModule.main,
	};
}

export function isFastVersionCommand(args: readonly string[]): boolean {
	return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
}

export async function bootstrap(args: string[], dependencies?: BootstrapDependencies): Promise<void> {
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	if (isFastVersionCommand(args)) {
		(dependencies?.writeVersion ?? ((version) => console.log(version)))(VERSION);
		return;
	}

	const loaded = dependencies ?? {
		...(await loadBootstrapDependencies()),
		writeVersion: (version: string) => console.log(version),
	};
	loaded.configureHttpDispatcher();
	await loaded.runMain(args);
}
