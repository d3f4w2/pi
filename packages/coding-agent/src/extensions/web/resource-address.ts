export type ExternalResourceScheme = "github" | "gitlab" | "npm" | "pypi" | "crates" | "go-package" | "arxiv" | "osv";

export interface ParsedExternalResourceAddress {
	scheme: ExternalResourceScheme;
	canonicalAddress: string;
	identifier: string;
	segments: readonly string[];
	operation?: string;
	operationIndex?: number;
}

const RESOURCE_SCHEMES = new Set<ExternalResourceScheme>([
	"github",
	"gitlab",
	"npm",
	"pypi",
	"crates",
	"go-package",
	"arxiv",
	"osv",
]);
const MAX_ADDRESS_LENGTH = 8_192;
const MAX_SEGMENT_LENGTH = 1_024;

function decodeSegment(raw: string): string {
	let value: string;
	try {
		value = decodeURIComponent(raw);
	} catch {
		throw new Error("Resource address contains invalid percent encoding.");
	}
	if (!value || value.length > MAX_SEGMENT_LENGTH) throw new Error("Resource address segment is empty or too long.");
	if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
		throw new Error("Resource address contains an unsafe path segment.");
	}
	if (/\p{Cc}/u.test(value)) throw new Error("Resource address contains control characters.");
	return value;
}

function canonicalAddress(scheme: ExternalResourceScheme, segments: readonly string[]): string {
	return `${scheme}://${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function requireSimpleIdentifier(scheme: ExternalResourceScheme, segments: readonly string[]): string {
	if (segments.length !== 1) throw new Error(`${scheme} resource address requires exactly one identifier.`);
	return segments[0] ?? "";
}

function validateGitHostAddress(
	scheme: "github" | "gitlab",
	segments: readonly string[],
): ParsedExternalResourceAddress {
	if (segments.length < 2) throw new Error(`${scheme} resource address requires an owner and repository.`);
	const separatorIndexes =
		scheme === "gitlab" ? segments.flatMap((segment, index) => (segment === "-" ? [index] : [])) : [];
	if (separatorIndexes.length > 1) throw new Error("gitlab resource address contains multiple operation delimiters.");
	const separatorIndex = separatorIndexes[0];
	if (separatorIndex !== undefined && (separatorIndex < 2 || separatorIndex >= segments.length - 1)) {
		throw new Error("gitlab operation delimiter must follow a project and precede an operation.");
	}
	const candidateIndex =
		scheme === "github" ? (segments.length > 2 ? 2 : -1) : separatorIndex === undefined ? -1 : separatorIndex + 1;
	const operationIndex = candidateIndex < 0 ? undefined : candidateIndex;
	const operation = operationIndex === undefined ? undefined : segments[operationIndex];
	const projectSegments = segments.slice(0, separatorIndex ?? operationIndex ?? segments.length);
	if (operation === undefined) {
		return {
			scheme,
			canonicalAddress: canonicalAddress(scheme, segments),
			identifier: projectSegments.join("/"),
			segments,
		};
	}
	const allowed =
		scheme === "github"
			? new Set(["file", "commit", "pull", "issue", "diff"])
			: new Set(["file", "commit", "merge-request", "issue"]);
	if (!allowed.has(operation)) throw new Error(`Unsupported ${scheme} resource operation: ${operation}.`);
	const tail = segments.slice((operationIndex ?? 0) + 1);
	if (operation === "file" && tail.length < 2) {
		throw new Error(`${scheme} file address requires a ref and path.`);
	}
	if (operation === "commit" && tail.length !== 1) {
		throw new Error(`${scheme} commit address requires one revision.`);
	}
	if (operation === "pull" || operation === "merge-request" || operation === "issue") {
		if (tail.length !== 1 || !/^\d+$/.test(tail[0] ?? "")) {
			throw new Error(`${scheme} ${operation} address requires a numeric identifier.`);
		}
	}
	if (operation === "diff") {
		const revisions = tail[0]?.split("...") ?? [];
		if (tail.length !== 1 || revisions.length !== 2 || revisions.some((revision) => revision.length === 0)) {
			throw new Error("github diff address requires exactly one <base>...<head> pair.");
		}
	}
	return {
		scheme,
		canonicalAddress: canonicalAddress(scheme, segments),
		identifier: projectSegments.join("/"),
		segments,
		operation,
		operationIndex,
	};
}

export function isExternalResourceAddress(value: string): boolean {
	const match = /^([a-z][a-z\d+.-]*):\/\//i.exec(value.trim());
	return match !== null && RESOURCE_SCHEMES.has(match[1]?.toLowerCase() as ExternalResourceScheme);
}

export function parseExternalResourceAddress(value: string): ParsedExternalResourceAddress {
	const input = value.trim();
	if (!input || input.length > MAX_ADDRESS_LENGTH) throw new Error("Resource address is empty or too long.");
	const match = /^([a-z][a-z\d+.-]*):\/\/(.+)$/i.exec(input);
	if (!match) throw new Error("External resource address is invalid.");
	const scheme = match[1]?.toLowerCase() as ExternalResourceScheme;
	if (!RESOURCE_SCHEMES.has(scheme)) throw new Error(`Unsupported external resource scheme: ${match[1]}.`);
	const rawPath = match[2] ?? "";
	if (rawPath.includes("#")) throw new Error("External resource address cannot contain a fragment.");
	if (rawPath.includes("?")) throw new Error("External resource address cannot contain a query.");
	if (/^[^/]*:[^/]*@/.test(rawPath)) throw new Error("External resource address cannot contain credentials.");
	const rawSegments = rawPath.split("/");
	if (rawSegments.some((segment) => segment === "")) throw new Error("Resource address contains an empty segment.");
	const segments = rawSegments.map(decodeSegment);

	if (scheme === "github" || scheme === "gitlab") return validateGitHostAddress(scheme, segments);
	let identifier: string;
	if (scheme === "npm") {
		if (segments.length === 1) identifier = segments[0] ?? "";
		else if (segments.length === 2 && segments[0]?.startsWith("@")) identifier = `${segments[0]}/${segments[1]}`;
		else throw new Error("npm resource address requires a package or @scope/package.");
	} else if (scheme === "go-package") {
		identifier = segments.join("/");
		if (!identifier.includes(".")) throw new Error("go-package address requires a module path.");
	} else if (scheme === "arxiv") {
		if (segments.length > 2) throw new Error("arxiv resource address contains too many path segments.");
		identifier = segments.join("/");
	} else {
		identifier = requireSimpleIdentifier(scheme, segments);
	}
	if (scheme === "arxiv" && !/^\d{4}\.\d{4,5}(?:v\d+)?$|^[a-z-]+\/\d{7}(?:v\d+)?$/i.test(identifier)) {
		throw new Error("arxiv resource address contains an invalid paper identifier.");
	}
	if (scheme === "osv" && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/.test(identifier)) {
		throw new Error("osv resource address contains an invalid vulnerability identifier.");
	}
	return {
		scheme,
		canonicalAddress: canonicalAddress(scheme, segments),
		identifier,
		segments,
	};
}
