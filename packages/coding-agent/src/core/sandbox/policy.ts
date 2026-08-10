import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type SandboxMode = "auto" | "read-only" | "full-access";
export type SandboxPathAccess = "read" | "write";

export interface CompileSandboxPolicyOptions {
	mode: SandboxMode;
	workspaceRoot: string;
	sandboxTempRoot: string;
	userHome: string;
	controlRoots?: readonly string[];
	platform?: NodeJS.Platform;
}

export interface SandboxPolicy {
	mode: SandboxMode;
	platform: NodeJS.Platform;
	workspaceRoot: string;
	sandboxTempRoot: string;
	userHome: string;
	readRoots: readonly string[];
	writeRoots: readonly string[];
	deniedReadRoots: readonly string[];
	deniedWriteRoots: readonly string[];
}

export interface SandboxPathDecision {
	allowed: boolean;
	canonicalPath: string;
	reason?: string;
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
	return platform === "win32" ? path.win32 : path.posix;
}

function normalizeForComparison(value: string, platform: NodeJS.Platform): string {
	const normalized = pathApi(platform).normalize(value);
	return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string, platform: NodeJS.Platform): boolean {
	const api = pathApi(platform);
	const normalizedRoot = normalizeForComparison(root, platform);
	const normalizedCandidate = normalizeForComparison(candidate, platform);
	const relativePath = api.relative(normalizedRoot, normalizedCandidate);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${api.sep}`) && relativePath !== ".." && !api.isAbsolute(relativePath))
	);
}

async function canonicalizePath(candidate: string, platform: NodeJS.Platform): Promise<string> {
	const api = pathApi(platform);
	let current = api.resolve(candidate);
	const missingParts: string[] = [];

	for (;;) {
		try {
			await stat(current);
			const resolved = await realpath(current);
			return missingParts.reduceRight((base, part) => api.join(base, part), resolved);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) {
				throw error;
			}
			const parent = api.dirname(current);
			if (parent === current) throw error;
			missingParts.push(api.basename(current));
			current = parent;
		}
	}
}

function relativeComponents(root: string, candidate: string, platform: NodeJS.Platform): string[] {
	if (!isWithin(root, candidate, platform)) return [];
	const relativePath = pathApi(platform).relative(root, candidate);
	return relativePath
		.split(/[\\/]+/)
		.filter(Boolean)
		.map((component) => (platform === "win32" || platform === "darwin" ? component.toLowerCase() : component));
}

function protectedReadComponent(component: string): boolean {
	return component === ".pi" || component === ".env" || component.startsWith(".env.");
}

function protectedWriteComponent(component: string): boolean {
	return component === ".git" || protectedReadComponent(component);
}

function containsProtectedComponent(policy: SandboxPolicy, candidate: string, access: SandboxPathAccess): boolean {
	for (const root of [policy.workspaceRoot, policy.sandboxTempRoot]) {
		const components = relativeComponents(root, candidate, policy.platform);
		if (components.some(access === "read" ? protectedReadComponent : protectedWriteComponent)) return true;
	}
	return false;
}

async function canonicalRoot(value: string, platform: NodeJS.Platform): Promise<string> {
	return normalizeForComparison(await canonicalizePath(value, platform), platform);
}

export async function compileSandboxPolicy(options: CompileSandboxPolicyOptions): Promise<SandboxPolicy> {
	const platform = options.platform ?? process.platform;
	const [workspaceRoot, sandboxTempRoot, userHome, controlRoots] = await Promise.all([
		canonicalRoot(options.workspaceRoot, platform),
		canonicalRoot(options.sandboxTempRoot, platform),
		canonicalRoot(options.userHome, platform),
		Promise.all((options.controlRoots ?? []).map((root) => canonicalRoot(root, platform))),
	]);
	const homePath = (...parts: string[]) => pathApi(platform).join(userHome, ...parts);
	const credentialRoots = [
		homePath(".ssh"),
		homePath(".aws"),
		homePath(".azure"),
		homePath(".gnupg"),
		homePath(".kube"),
		homePath(".docker"),
		homePath(".config", "gcloud"),
		homePath(".config", "gh"),
		homePath(".npmrc"),
		homePath(".netrc"),
		homePath(".git-credentials"),
		...(platform === "win32"
			? [homePath("AppData", "Roaming", "gcloud"), homePath("AppData", "Roaming", "GitHub CLI")]
			: []),
		...controlRoots,
	];
	return {
		mode: options.mode,
		platform,
		workspaceRoot,
		sandboxTempRoot,
		userHome,
		readRoots: [workspaceRoot, sandboxTempRoot],
		writeRoots: options.mode === "read-only" ? [sandboxTempRoot] : [workspaceRoot, sandboxTempRoot],
		deniedReadRoots: credentialRoots,
		deniedWriteRoots: credentialRoots,
	};
}

export async function checkSandboxPath(
	policy: SandboxPolicy,
	candidate: string,
	access: SandboxPathAccess,
): Promise<SandboxPathDecision> {
	if (policy.mode === "full-access") {
		return { allowed: true, canonicalPath: pathApi(policy.platform).resolve(candidate) };
	}

	const canonicalPath = normalizeForComparison(await canonicalizePath(candidate, policy.platform), policy.platform);
	const deniedRoots = access === "read" ? policy.deniedReadRoots : policy.deniedWriteRoots;
	if (deniedRoots.some((root) => isWithin(root, canonicalPath, policy.platform))) {
		return { allowed: false, canonicalPath, reason: `Sandbox denied ${access} access to a credential path.` };
	}
	if (containsProtectedComponent(policy, canonicalPath, access)) {
		return { allowed: false, canonicalPath, reason: `Sandbox denied ${access} access to protected control data.` };
	}
	const allowedRoots = access === "read" ? policy.readRoots : policy.writeRoots;
	if (!allowedRoots.some((root) => isWithin(root, canonicalPath, policy.platform))) {
		return { allowed: false, canonicalPath, reason: `Sandbox denied ${access} access outside its allowed roots.` };
	}
	return { allowed: true, canonicalPath };
}
