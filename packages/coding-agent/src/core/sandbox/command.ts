const MAX_COMMAND_CHARACTERS = 32_768;
const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_CHARACTERS = 1_048_576;

export interface SandboxLaunchRequest {
	version: 1;
	command: string;
	args: string[];
	cwd: string;
	workspaceRoot: string;
	tempRoot: string;
	readOnly: boolean;
	protectedWritePaths: string[];
}

function assertSafeString(value: string, label: string, maximum = MAX_ARGUMENT_CHARACTERS): void {
	if (value.includes("\0")) throw new Error(`${label} contains a NUL byte.`);
	if (value.length > maximum) throw new Error(`${label} is too long.`);
}

function quotePosixArgument(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShellArgument(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function buildPosixCommand(command: string, args: readonly string[]): string {
	assertSafeString(command, "Command", MAX_COMMAND_CHARACTERS);
	if (!command) throw new Error("Command cannot be empty.");
	if (args.length > MAX_ARGUMENTS) throw new Error("Command has too many arguments.");
	for (const [index, arg] of args.entries()) assertSafeString(arg, `Argument ${index}`);
	return [command, ...args].map(quotePosixArgument).join(" ");
}

export function buildPowerShellCommand(
	command: string,
	args: readonly string[],
	environment: NodeJS.ProcessEnv = {},
): string {
	assertSafeString(command, "Command", MAX_COMMAND_CHARACTERS);
	if (!command) throw new Error("Command cannot be empty.");
	if (args.length > MAX_ARGUMENTS) throw new Error("Command has too many arguments.");
	for (const [index, arg] of args.entries()) assertSafeString(arg, `Argument ${index}`);

	const statements: string[] = [];
	for (const [name, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
		if (value === undefined) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid sandbox environment name: ${name}`);
		assertSafeString(value, `Environment variable ${name}`);
		statements.push(`$env:${name}=${quotePowerShellArgument(value)}`);
	}
	statements.push(`& ${[command, ...args].map(quotePowerShellArgument).join(" ")}`);
	statements.push("exit $LASTEXITCODE");
	return statements.join("; ");
}

function validateLaunchRequest(request: SandboxLaunchRequest): void {
	if (request.version !== 1) throw new Error("Unsupported sandbox launch request version.");
	assertSafeString(request.command, "Command", MAX_COMMAND_CHARACTERS);
	if (!request.command) throw new Error("Command cannot be empty.");
	if (request.args.length > MAX_ARGUMENTS) throw new Error("Command has too many arguments.");
	for (const [index, arg] of request.args.entries()) assertSafeString(arg, `Argument ${index}`);
	for (const [label, value] of [
		["Working directory", request.cwd],
		["Workspace root", request.workspaceRoot],
		["Temporary root", request.tempRoot],
	] as const) {
		assertSafeString(value, label, MAX_COMMAND_CHARACTERS);
	}
	for (const [index, value] of request.protectedWritePaths.entries()) {
		assertSafeString(value, `Protected write path ${index}`);
	}
}

export function encodeSandboxLaunchRequest(request: SandboxLaunchRequest): string {
	validateLaunchRequest(request);
	return Buffer.from(JSON.stringify(request), "utf8").toString("base64");
}

export function decodeSandboxLaunchRequest(encoded: string): SandboxLaunchRequest {
	const value: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid sandbox launch request.");
	}
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.command !== "string" ||
		!Array.isArray(record.args) ||
		!record.args.every((arg) => typeof arg === "string") ||
		typeof record.cwd !== "string" ||
		typeof record.workspaceRoot !== "string" ||
		typeof record.tempRoot !== "string" ||
		typeof record.readOnly !== "boolean" ||
		!Array.isArray(record.protectedWritePaths) ||
		!record.protectedWritePaths.every((protectedPath) => typeof protectedPath === "string")
	) {
		throw new Error("Invalid sandbox launch request.");
	}
	const request: SandboxLaunchRequest = {
		version: 1,
		command: record.command,
		args: record.args as string[],
		cwd: record.cwd,
		workspaceRoot: record.workspaceRoot,
		tempRoot: record.tempRoot,
		readOnly: record.readOnly,
		protectedWritePaths: record.protectedWritePaths as string[],
	};
	validateLaunchRequest(request);
	return request;
}
