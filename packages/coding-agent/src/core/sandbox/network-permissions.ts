import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

export type SandboxNetworkAccessDecision = "deny" | "allow-command" | "allow-session" | "allow-workspace";

export interface SandboxNetworkAccessRequest {
	host: string;
	port: number;
	destination: string;
}

export type SandboxNetworkAccessPrompt = (
	request: SandboxNetworkAccessRequest,
) => Promise<SandboxNetworkAccessDecision | undefined>;

export interface SandboxNetworkCommandScope {
	close(): void;
}

interface NormalizedNetworkDestination extends SandboxNetworkAccessRequest {
	key: string;
}

interface ActiveCommandScope {
	active: boolean;
	allowed: Set<string>;
	denied: Set<string>;
	pending: Map<string, Promise<boolean>>;
	promptCount: number;
	promptTail: Promise<void>;
	prompt: SandboxNetworkAccessPrompt | undefined;
}

interface StoredNetworkPermission {
	version: 1;
	workspaceRoot: string;
	destination: string;
}

export interface SandboxNetworkPermissionManagerOptions {
	storageRoot: string;
	platform?: NodeJS.Platform;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_HOST = /^(?:0x[0-9a-f]+|[0-9.]+)$/i;
const MAX_NETWORK_PROMPTS_PER_COMMAND = 8;

function canonicalizeNumericHost(host: string): string | undefined {
	if (!NUMERIC_HOST.test(host)) return undefined;
	try {
		const canonical = new URL(`http://${host}`).hostname;
		return isIP(canonical) === 4 ? canonical : undefined;
	} catch {
		return undefined;
	}
}

function normalizeHostname(host: string): string | undefined {
	const normalized = host.trim().toLowerCase().replace(/\.$/, "");
	if (!normalized || normalized.length > 253) return undefined;
	if (isIP(normalized) !== 0) return normalized;
	const numericHost = canonicalizeNumericHost(normalized);
	if (numericHost) return numericHost;
	const labels = normalized.split(".");
	if (labels.some((label) => !DNS_LABEL.test(label))) return undefined;
	return normalized;
}

export function normalizeSandboxNetworkDestination(
	host: string,
	port: number | undefined,
): SandboxNetworkAccessRequest | undefined {
	const normalizedHost = normalizeHostname(host);
	if (!normalizedHost || !Number.isInteger(port) || port === undefined || port < 1 || port > 65_535) {
		return undefined;
	}
	const destination = isIP(normalizedHost) === 6 ? `[${normalizedHost}]:${port}` : `${normalizedHost}:${port}`;
	return { host: normalizedHost, port, destination };
}

export function isSensitiveSandboxNetworkHost(host: string): boolean {
	const normalized = host.toLowerCase();
	if (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized === "metadata.google.internal"
	) {
		return true;
	}
	if (isIP(normalized) === 6) {
		const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
		if (mappedIpv4) return isSensitiveSandboxNetworkHost(mappedIpv4);
		return normalized === "::" || normalized === "::1" || /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized);
	}
	if (isIP(normalized) !== 4) return false;
	const [first = 0, second = 0] = normalized.split(".").map(Number);
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 100 && second >= 64 && second <= 127) ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		first >= 224
	);
}

function normalizeWorkspaceRoot(workspaceRoot: string, platform: NodeJS.Platform): string {
	const resolved = path.resolve(workspaceRoot);
	return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function isStoredNetworkPermission(value: unknown): value is StoredNetworkPermission {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === 1 && typeof record.workspaceRoot === "string" && typeof record.destination === "string";
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export class SandboxNetworkPermissionManager {
	private readonly workspaceRoot: string;
	private readonly workspaceDirectory: string;
	private readonly activeCommands = new Map<symbol, ActiveCommandScope>();
	private readonly sessionAllowed = new Set<string>();
	private readonly persistentAllowed = new Set<string>();

	constructor(workspaceRoot: string, options: SandboxNetworkPermissionManagerOptions) {
		const platform = options.platform ?? process.platform;
		this.workspaceRoot = normalizeWorkspaceRoot(workspaceRoot, platform);
		const workspaceId = createHash("sha256").update(this.workspaceRoot).digest("hex");
		this.workspaceDirectory = path.join(options.storageRoot, workspaceId);
	}

	openCommand(prompt?: SandboxNetworkAccessPrompt): SandboxNetworkCommandScope {
		const id = Symbol("sandbox-network-command");
		const scope: ActiveCommandScope = {
			active: true,
			allowed: new Set(),
			denied: new Set(),
			pending: new Map(),
			promptCount: 0,
			promptTail: Promise.resolve(),
			prompt,
		};
		this.activeCommands.set(id, scope);
		return {
			close: () => {
				if (!scope.active) return;
				scope.active = false;
				scope.pending.clear();
				this.activeCommands.delete(id);
			},
		};
	}

	async request(host: string, port: number | undefined): Promise<boolean> {
		const destination = normalizeSandboxNetworkDestination(host, port);
		if (!destination) return false;
		const normalized: NormalizedNetworkDestination = { ...destination, key: destination.destination };
		if (this.activeCommands.size === 0) return false;
		if (this.sessionAllowed.has(normalized.key) || (await this.isPersistentlyAllowed(normalized.key))) return true;

		if (this.activeCommands.size !== 1) return false;
		const scope = this.activeCommands.values().next().value as ActiveCommandScope | undefined;
		if (!scope?.active) return false;
		if (scope.allowed.has(normalized.key)) return true;
		if (scope.denied.has(normalized.key) || !scope.prompt) return false;

		const existing = scope.pending.get(normalized.key);
		if (existing) return existing;
		if (scope.promptCount >= MAX_NETWORK_PROMPTS_PER_COMMAND) return false;
		scope.promptCount++;
		const pending = this.enqueuePrompt(scope, normalized);
		scope.pending.set(normalized.key, pending);
		try {
			return await pending;
		} finally {
			if (scope.pending.get(normalized.key) === pending) scope.pending.delete(normalized.key);
		}
	}

	private async enqueuePrompt(scope: ActiveCommandScope, destination: NormalizedNetworkDestination): Promise<boolean> {
		const previous = scope.promptTail;
		let release = () => {};
		scope.promptTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			if (!scope.active) return false;
			return await this.resolvePrompt(scope, destination);
		} finally {
			release();
		}
	}

	private async resolvePrompt(scope: ActiveCommandScope, destination: NormalizedNetworkDestination): Promise<boolean> {
		let decision: SandboxNetworkAccessDecision | undefined;
		try {
			decision = await scope.prompt?.(destination);
		} catch {
			decision = "deny";
		}
		if (!scope.active) return false;

		switch (decision) {
			case "allow-command":
				scope.allowed.add(destination.key);
				return true;
			case "allow-session":
				this.sessionAllowed.add(destination.key);
				return true;
			case "allow-workspace":
				try {
					await this.persist(destination.key);
					this.persistentAllowed.add(destination.key);
					return true;
				} catch {
					scope.denied.add(destination.key);
					return false;
				}
			case "deny":
			case undefined:
				scope.denied.add(destination.key);
				return false;
		}
	}

	private permissionPath(destination: string): string {
		const permissionId = createHash("sha256").update(destination).digest("hex");
		return path.join(this.workspaceDirectory, `${permissionId}.json`);
	}

	private async isPersistentlyAllowed(destination: string): Promise<boolean> {
		if (this.persistentAllowed.has(destination)) return true;
		try {
			const stored = JSON.parse(await readFile(this.permissionPath(destination), "utf8")) as unknown;
			if (
				!isStoredNetworkPermission(stored) ||
				stored.workspaceRoot !== this.workspaceRoot ||
				stored.destination !== destination
			) {
				return false;
			}
			this.persistentAllowed.add(destination);
			return true;
		} catch {
			return false;
		}
	}

	private async persist(destination: string): Promise<void> {
		await mkdir(this.workspaceDirectory, { recursive: true, mode: 0o700 });
		const stored: StoredNetworkPermission = {
			version: 1,
			workspaceRoot: this.workspaceRoot,
			destination,
		};
		const permissionPath = this.permissionPath(destination);
		try {
			await writeFile(permissionPath, `${JSON.stringify(stored)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		} catch (error) {
			if (!isAlreadyExists(error) || !(await this.isPersistentlyAllowed(destination))) throw error;
		}
	}
}
