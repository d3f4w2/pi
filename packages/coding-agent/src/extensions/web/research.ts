import { parseExternalResourceAddress } from "./resource-address.ts";
import type { SearchResultItem } from "./types.ts";

export type OfficialSourceKind =
	| "github"
	| "gitlab"
	| "npm"
	| "pypi"
	| "crates"
	| "go-package"
	| "arxiv"
	| "stackoverflow"
	| "mdn"
	| "docs-rs"
	| "read-the-docs"
	| "osv"
	| "nvd"
	| "cisa-kev";

export interface OfficialResearchHit {
	kind: OfficialSourceKind;
	sourceAddress: string;
	url: string;
	title: string;
}

const URL_ONLY = /^https?:\/\/\S+$/i;

function resourceUrl(address: string): { kind: OfficialSourceKind; url: string; title: string } {
	const resource = parseExternalResourceAddress(address);
	const encodedIdentifier = resource.segments.map(encodeURIComponent).join("/");
	if (resource.scheme === "github") {
		const [owner, repository, operation, ...rest] = resource.segments;
		const root = `https://github.com/${owner}/${repository}`;
		const suffix =
			operation === "file"
				? `/blob/${rest.join("/")}`
				: operation === "pull"
					? `/pull/${rest[0]}`
					: operation === "issue"
						? `/issues/${rest[0]}`
						: operation === "commit"
							? `/commit/${rest[0]}`
							: operation === "diff"
								? `/compare/${rest[0]}`
								: "";
		return { kind: "github", url: `${root}${suffix}`, title: `${resource.identifier} on GitHub` };
	}
	if (resource.scheme === "gitlab") {
		const operationIndex = resource.operationIndex ?? resource.segments.length;
		const rest = resource.segments.slice(operationIndex + 1);
		const root = `https://gitlab.com/${resource.identifier}`;
		const suffix =
			resource.operation === "file"
				? `/-/blob/${rest.join("/")}`
				: resource.operation === "commit"
					? `/-/commit/${rest[0]}`
					: resource.operation === "merge-request"
						? `/-/merge_requests/${rest[0]}`
						: resource.operation === "issue"
							? `/-/issues/${rest[0]}`
							: "";
		return {
			kind: "gitlab",
			url: `${root}${suffix}`,
			title: `${resource.identifier} on GitLab`,
		};
	}
	if (resource.scheme === "npm") {
		return {
			kind: "npm",
			url: `https://www.npmjs.com/package/${resource.identifier}`,
			title: `${resource.identifier} on npm`,
		};
	}
	if (resource.scheme === "pypi") {
		return {
			kind: "pypi",
			url: `https://pypi.org/project/${resource.identifier}/`,
			title: `${resource.identifier} on PyPI`,
		};
	}
	if (resource.scheme === "crates") {
		return {
			kind: "crates",
			url: `https://crates.io/crates/${resource.identifier}`,
			title: `${resource.identifier} on crates.io`,
		};
	}
	if (resource.scheme === "go-package") {
		return {
			kind: "go-package",
			url: `https://pkg.go.dev/${resource.identifier}`,
			title: `${resource.identifier} on Go Packages`,
		};
	}
	if (resource.scheme === "arxiv") {
		return {
			kind: "arxiv",
			url: `https://arxiv.org/abs/${resource.identifier}`,
			title: `arXiv ${resource.identifier}`,
		};
	}
	return {
		kind: "osv",
		url: `https://osv.dev/vulnerability/${encodedIdentifier}`,
		title: `${resource.identifier} in OSV`,
	};
}

function officialUrlHit(value: string): OfficialResearchHit | undefined {
	if (!URL_ONLY.test(value)) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.username || url.password) return undefined;
	const host = url.hostname.toLowerCase();
	const hostKind: ReadonlyArray<readonly [boolean, OfficialSourceKind]> = [
		[host === "stackoverflow.com", "stackoverflow"],
		[host === "developer.mozilla.org", "mdn"],
		[host === "docs.rs", "docs-rs"],
		[host.endsWith(".readthedocs.io") || host.endsWith(".readthedocs.org"), "read-the-docs"],
	];
	const kind = hostKind.find(([matches]) => matches)?.[1];
	if (!kind) return undefined;
	return { kind, sourceAddress: url.toString(), url: url.toString(), title: `Official ${kind} source` };
}

function explicitResourceAddress(query: string): string | undefined {
	if (/^(?:github|gitlab|npm|pypi|crates|go-package|arxiv|osv):\/\//i.test(query)) return query;
	const githubOperation = /^github\s+([\w.-]+\/[\w.-]+)\s+(pull|pr|issue|commit|diff)\s+(\S+)$/i.exec(query);
	if (githubOperation) {
		const operation = githubOperation[2]?.toLowerCase() === "pr" ? "pull" : githubOperation[2]?.toLowerCase();
		return `github://${githubOperation[1]}/${operation}/${githubOperation[3]}`;
	}
	const gitlabOperation = /^gitlab\s+((?:[\w.-]+\/)+[\w.-]+)\s+(?:merge-request|mr|issue|commit)\s+(\S+)$/i.exec(
		query,
	);
	if (gitlabOperation) {
		const rawOperation = query.split(/\s+/)[2]?.toLowerCase();
		const operation = rawOperation === "mr" ? "merge-request" : rawOperation;
		return `gitlab://${gitlabOperation[1]}/-/${operation}/${gitlabOperation[2]}`;
	}
	const matchers: ReadonlyArray<readonly [RegExp, string]> = [
		[/^github\s+([\w.-]+\/[\w.-]+)$/i, "github"],
		[/^gitlab\s+((?:[\w.-]+\/)+[\w.-]+)$/i, "gitlab"],
		[/^npm(?:\s+package)?\s+(@?[\w.-]+(?:\/[\w.-]+)?)$/i, "npm"],
		[/^pypi(?:\s+package)?\s+([\w.-]+)$/i, "pypi"],
		[/^(?:crate|crates)\s+([\w.-]+)$/i, "crates"],
		[/^(?:go\s+package|go\s+module)\s+(\S+)$/i, "go-package"],
		[/^arxiv\s+([\w.-]+(?:\/\d{7})?)$/i, "arxiv"],
		[/^(?:osv\s+)?((?:GHSA|OSV|RUSTSEC|PYSEC|GO)-[\w.-]+)$/i, "osv"],
	];
	for (const [pattern, scheme] of matchers) {
		const identifier = pattern.exec(query)?.[1];
		if (identifier) return `${scheme}://${identifier}`;
	}
	return undefined;
}

export function classifyOfficialResearchQuery(value: string): OfficialResearchHit | undefined {
	const query = value.trim();
	const urlHit = officialUrlHit(query);
	if (urlHit) return urlHit;
	const resourceAddress = explicitResourceAddress(query);
	if (resourceAddress) {
		try {
			const canonical = parseExternalResourceAddress(resourceAddress).canonicalAddress;
			return { ...resourceUrl(canonical), sourceAddress: canonical };
		} catch {
			return undefined;
		}
	}
	const cve = /\b(CVE-\d{4}-\d{4,})\b/i.exec(query)?.[1]?.toUpperCase();
	if (!cve) return undefined;
	if (/\b(?:CISA|KEV|exploited)\b/i.test(query)) {
		const url = `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?cve=${encodeURIComponent(cve)}`;
		return {
			kind: "cisa-kev",
			sourceAddress: url,
			url,
			title: `${cve} in CISA KEV`,
		};
	}
	return {
		kind: "nvd",
		sourceAddress: `https://nvd.nist.gov/vuln/detail/${cve}`,
		url: `https://nvd.nist.gov/vuln/detail/${cve}`,
		title: `${cve} in NVD`,
	};
}

export function officialResearchResults(
	query: string,
): { hit: OfficialResearchHit; results: SearchResultItem[] } | undefined {
	const hit = classifyOfficialResearchQuery(query);
	if (!hit) return undefined;
	return {
		hit,
		results: [
			{
				title: hit.title,
				url: hit.url,
				snippet: `Official structured source. Read with ${hit.sourceAddress}.`,
			},
		],
	};
}
