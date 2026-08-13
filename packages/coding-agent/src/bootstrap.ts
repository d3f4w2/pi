import { APP_NAME, VERSION } from "./build-info.ts";
import { printHelp } from "./cli/args.ts";
import { runCiCommand } from "./cli/ci-command.ts";
import { runDoctorCommand } from "./cli/doctor-command.ts";
import { runRunCommand } from "./cli/run-command.ts";

interface BootstrapDependencies {
	configureHttpDispatcher: () => void;
	runDoctor: (args: string[]) => void | Promise<void>;
	runCi?: (args: string[]) => void | Promise<void>;
	runRun?: (args: string[]) => void | Promise<void>;
	runMain: (args: string[]) => Promise<void>;
	writeHelp: () => void | Promise<void>;
	writeVersion: (version: string) => void;
}

async function loadBootstrapDependencies(): Promise<
	Pick<BootstrapDependencies, "configureHttpDispatcher" | "runMain">
> {
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

export function isFastHelpCommand(args: readonly string[]): boolean {
	return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
}

export function isDoctorCommand(args: readonly string[]): boolean {
	return args[0] === "doctor";
}

export function isCiCommand(args: readonly string[]): boolean {
	return args[0] === "ci";
}

export function isRunCommand(args: readonly string[]): boolean {
	return args[0] === "run";
}

async function writeStandaloneHelp(): Promise<void> {
	printHelp();
}

function runStandaloneDoctor(args: string[]): void {
	runDoctorCommand(args);
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
	if (isFastHelpCommand(args)) {
		await (dependencies?.writeHelp ?? writeStandaloneHelp)();
		return;
	}
	if (isDoctorCommand(args)) {
		await (dependencies?.runDoctor ?? runStandaloneDoctor)(args.slice(1));
		return;
	}
	if (isCiCommand(args)) {
		await (dependencies?.runCi ?? runCiCommand)(args.slice(1));
		return;
	}
	if (isRunCommand(args)) {
		await (dependencies?.runRun ?? runRunCommand)(args.slice(1));
		return;
	}

	const loaded = dependencies ?? {
		...(await loadBootstrapDependencies()),
		runDoctor: runStandaloneDoctor,
		writeHelp: writeStandaloneHelp,
		writeVersion: (version: string) => console.log(version),
	};
	loaded.configureHttpDispatcher();
	await loaded.runMain(args);
}
