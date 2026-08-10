import { createHash } from "node:crypto";
import { htmlToMarkdown } from "./content.ts";
import { parseSafeHttpUrl } from "./network.ts";
import { type ParsedExternalResourceAddress, parseExternalResourceAddress } from "./resource-address.ts";
import { type ExternalResourceCache, externalResourceCache, type NetworkResourceFetcher } from "./resource-cache.ts";

const MAX_STRUCTURED_BYTES = 5 * 1024 * 1024;
const MAX_RENDERED_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ExternalResourceResult {
	data: Uint8Array;
	sourceAddress: string;
	finalUrl: string;
	contentType: string;
	cached: boolean;
	readAt: string;
	truncated: boolean;
	untrusted: true;
	contentSha256: string;
}

export interface SourceAdapterOptions {
	cache?: ExternalResourceCache;
	fetcher?: NetworkResourceFetcher;
	signal?: AbortSignal;
	timeoutSeconds?: number;
}

interface AdapterRequest {
	url: string;
	accept: string;
	render: (
		body: Uint8Array,
		contentType: string,
		finalUrl: string,
	) => string | Uint8Array | Promise<string | Uint8Array>;
}

type JsonObject = Record<string, unknown>;

function encodePath(segments: readonly string[]): string {
	return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function encodeGoProxyPath(segments: readonly string[]): string {
	return segments
		.map((segment) => encodeURIComponent(segment.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`)))
		.join("/");
}

function asObject(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Official source returned invalid JSON.");
	return value as JsonObject;
}

function parseJson(data: Uint8Array): unknown {
	try {
		return JSON.parse(decoder.decode(data)) as unknown;
	} catch {
		throw new Error("Official source returned invalid JSON.");
	}
}

function prettyJson(data: Uint8Array): string {
	return `${JSON.stringify(parseJson(data), null, 2)}\n`;
}

function objectOrUndefined(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function selectedFields(source: JsonObject | undefined, fields: readonly string[]): JsonObject {
	if (!source) return {};
	return Object.fromEntries(fields.flatMap((field) => (source[field] === undefined ? [] : [[field, source[field]]])));
}

function formattedJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function compactRepositoryMetadata(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	return formattedJson(
		selectedFields(payload, [
			"id",
			"name",
			"full_name",
			"path_with_namespace",
			"description",
			"web_url",
			"html_url",
			"default_branch",
			"visibility",
			"archived",
			"fork",
			"language",
			"license",
			"topics",
			"star_count",
			"stargazers_count",
			"forks_count",
			"open_issues_count",
			"created_at",
			"updated_at",
			"pushed_at",
		]),
	);
}

function compactCommitMetadata(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	const commit = objectOrUndefined(payload.commit);
	const files = Array.isArray(payload.files) ? payload.files : [];
	return formattedJson({
		...selectedFields(payload, [
			"id",
			"sha",
			"short_id",
			"title",
			"message",
			"web_url",
			"html_url",
			"created_at",
			"committed_date",
			"authored_date",
			"author_name",
			"author_email",
			"committer_name",
			"committer_email",
			"parent_ids",
		]),
		commit: selectedFields(commit, ["message", "author", "committer", "verification"]),
		author: selectedFields(objectOrUndefined(payload.author), ["login", "name", "web_url", "html_url"]),
		committer: selectedFields(objectOrUndefined(payload.committer), ["login", "name", "web_url", "html_url"]),
		stats: payload.stats,
		parents: payload.parents,
		files: files.map((file) =>
			selectedFields(objectOrUndefined(file), [
				"filename",
				"status",
				"additions",
				"deletions",
				"changes",
				"blob_url",
			]),
		),
	});
}

function compactChangeRequestMetadata(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	return formattedJson({
		...selectedFields(payload, [
			"id",
			"number",
			"iid",
			"title",
			"body",
			"description",
			"state",
			"draft",
			"web_url",
			"html_url",
			"created_at",
			"updated_at",
			"closed_at",
			"merged_at",
			"mergeable",
			"merge_status",
			"comments",
			"comments_count",
			"commits",
			"changed_files",
			"additions",
			"deletions",
		]),
		author: selectedFields(objectOrUndefined(payload.user) ?? objectOrUndefined(payload.author), [
			"login",
			"username",
			"name",
			"web_url",
			"html_url",
		]),
		assignees: payload.assignees,
		labels: payload.labels,
		milestone: payload.milestone,
		head: payload.head,
		base: payload.base,
		source_branch: payload.source_branch,
		target_branch: payload.target_branch,
	});
}

function compactStackOverflowQuestion(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	const items = Array.isArray(payload.items) ? payload.items : [];
	return formattedJson({
		items: items.map((item) => {
			const question = objectOrUndefined(item);
			return {
				...selectedFields(question, [
					"question_id",
					"title",
					"link",
					"tags",
					"score",
					"view_count",
					"answer_count",
					"is_answered",
					"accepted_answer_id",
					"creation_date",
					"last_activity_date",
					"body",
				]),
				owner: selectedFields(objectOrUndefined(question?.owner), ["display_name", "link", "reputation"]),
			};
		}),
		...selectedFields(payload, ["has_more", "quota_remaining"]),
	});
}

function compactOsvVulnerability(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	const affected = Array.isArray(payload.affected) ? payload.affected : [];
	return formattedJson({
		...selectedFields(payload, [
			"id",
			"schema_version",
			"modified",
			"published",
			"withdrawn",
			"aliases",
			"related",
			"summary",
			"details",
			"severity",
			"references",
			"credits",
			"database_specific",
		]),
		affected: affected.map((item) =>
			selectedFields(objectOrUndefined(item), [
				"package",
				"severity",
				"ranges",
				"versions",
				"ecosystem_specific",
				"database_specific",
			]),
		),
	});
}

function compactNvdVulnerability(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	const vulnerabilities = Array.isArray(payload.vulnerabilities) ? payload.vulnerabilities : [];
	return formattedJson({
		...selectedFields(payload, ["resultsPerPage", "startIndex", "totalResults", "format", "version", "timestamp"]),
		vulnerabilities: vulnerabilities.map((item) => {
			const cve = objectOrUndefined(objectOrUndefined(item)?.cve);
			return {
				cve: selectedFields(cve, [
					"id",
					"sourceIdentifier",
					"published",
					"lastModified",
					"vulnStatus",
					"descriptions",
					"metrics",
					"weaknesses",
					"configurations",
					"references",
				]),
			};
		}),
	});
}

function compactNpmMetadata(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	const distTags = objectOrUndefined(payload["dist-tags"]);
	const latestVersion = typeof distTags?.latest === "string" ? distTags.latest : undefined;
	const versions = objectOrUndefined(payload.versions);
	const latest = latestVersion ? objectOrUndefined(versions?.[latestVersion]) : undefined;
	const time = objectOrUndefined(payload.time);
	return formattedJson({
		source: "npm",
		...selectedFields(payload, ["name", "description", "license", "homepage", "repository", "deprecated"]),
		latestVersion,
		distTags,
		latest: selectedFields(latest, [
			"version",
			"description",
			"license",
			"engines",
			"dependencies",
			"peerDependencies",
			"optionalDependencies",
			"deprecated",
			"dist",
		]),
		publishedAt: latestVersion ? time?.[latestVersion] : undefined,
		createdAt: time?.created,
		modifiedAt: time?.modified,
		versionCount: versions ? Object.keys(versions).length : undefined,
	});
}

function compactPypiMetadata(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	const info = objectOrUndefined(payload.info);
	const latestVersion = typeof info?.version === "string" ? info.version : undefined;
	const releases = objectOrUndefined(payload.releases);
	const latestFiles = latestVersion && Array.isArray(releases?.[latestVersion]) ? releases[latestVersion] : [];
	return formattedJson({
		source: "pypi",
		info: selectedFields(info, [
			"name",
			"version",
			"summary",
			"license",
			"requires_python",
			"requires_dist",
			"project_url",
			"project_urls",
			"home_page",
			"yanked",
		]),
		latestFiles: latestFiles.map((file) =>
			selectedFields(objectOrUndefined(file), [
				"filename",
				"packagetype",
				"python_version",
				"requires_python",
				"size",
				"upload_time_iso_8601",
				"url",
				"digests",
				"yanked",
			]),
		),
		releaseCount: releases ? Object.keys(releases).length : undefined,
	});
}

function compactCratesMetadata(data: Uint8Array): string {
	const payload = asObject(parseJson(data));
	const crate = objectOrUndefined(payload.crate);
	const latestVersion = typeof crate?.max_version === "string" ? crate.max_version : undefined;
	const versions = Array.isArray(payload.versions) ? payload.versions : [];
	const latest = versions.find((value) => objectOrUndefined(value)?.num === latestVersion);
	return formattedJson({
		source: "crates.io",
		crate: selectedFields(crate, [
			"id",
			"name",
			"description",
			"max_version",
			"max_stable_version",
			"newest_version",
			"downloads",
			"recent_downloads",
			"homepage",
			"repository",
			"documentation",
			"license",
			"updated_at",
		]),
		latest: selectedFields(objectOrUndefined(latest), [
			"num",
			"created_at",
			"updated_at",
			"downloads",
			"features",
			"license",
			"rust_version",
			"yanked",
		]),
		versionCount: versions.length,
	});
}

function compactCisaCatalog(data: Uint8Array, cve: string | undefined): string {
	const payload = asObject(parseJson(data));
	const vulnerabilities = Array.isArray(payload.vulnerabilities) ? payload.vulnerabilities : [];
	const selected = cve ? vulnerabilities.filter((value) => objectOrUndefined(value)?.cveID === cve) : vulnerabilities;
	return formattedJson({
		...selectedFields(payload, ["title", "catalogVersion", "dateReleased", "count"]),
		requestedCve: cve,
		matched: selected.length,
		vulnerabilities: selected,
	});
}

function githubRequest(resource: ParsedExternalResourceAddress): AdapterRequest {
	const [owner = "", repository = "", operation, ...rest] = resource.segments;
	const root = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
	if (!operation) return { url: root, accept: "application/vnd.github+json", render: compactRepositoryMetadata };
	if (operation === "file") {
		const [ref = "", ...path] = rest;
		return {
			url: `${root}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
			accept: "application/vnd.github+json",
			render: (body) => {
				const payload = asObject(parseJson(body));
				if (payload.encoding !== "base64" || typeof payload.content !== "string") {
					throw new Error("GitHub file response does not contain base64 content.");
				}
				return Uint8Array.from(Buffer.from(payload.content.replace(/\s/g, ""), "base64"));
			},
		};
	}
	if (operation === "commit") {
		return {
			url: `${root}/commits/${encodeURIComponent(rest[0] ?? "")}`,
			accept: "application/vnd.github+json",
			render: compactCommitMetadata,
		};
	}
	if (operation === "pull") {
		return {
			url: `${root}/pulls/${rest[0] ?? ""}`,
			accept: "application/vnd.github+json",
			render: compactChangeRequestMetadata,
		};
	}
	if (operation === "issue") {
		return {
			url: `${root}/issues/${rest[0] ?? ""}`,
			accept: "application/vnd.github+json",
			render: compactChangeRequestMetadata,
		};
	}
	const [base = "", head = ""] = (rest[0] ?? "").split("...");
	return {
		url: `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
		accept: "application/vnd.github.v3.diff",
		render: (body) => body,
	};
}

function gitlabRequest(resource: ParsedExternalResourceAddress): AdapterRequest {
	const operationIndex = resource.operationIndex ?? resource.segments.length;
	const operation = resource.operation;
	const rest = resource.segments.slice(operationIndex + 1);
	const project = encodeURIComponent(resource.identifier);
	const root = `https://gitlab.com/api/v4/projects/${project}`;
	if (!operation) return { url: root, accept: "application/json", render: compactRepositoryMetadata };
	if (operation === "file") {
		const [ref = "", ...path] = rest;
		return {
			url: `${root}/repository/files/${encodeURIComponent(path.join("/"))}?ref=${encodeURIComponent(ref)}`,
			accept: "application/json",
			render: (body) => {
				const payload = asObject(parseJson(body));
				if (payload.encoding !== "base64" || typeof payload.content !== "string") {
					throw new Error("GitLab file response does not contain base64 content.");
				}
				return Uint8Array.from(Buffer.from(payload.content.replace(/\s/g, ""), "base64"));
			},
		};
	}
	if (operation === "commit") {
		return {
			url: `${root}/repository/commits/${encodeURIComponent(rest[0] ?? "")}`,
			accept: "application/json",
			render: compactCommitMetadata,
		};
	}
	const collection = operation === "merge-request" ? "merge_requests" : "issues";
	return {
		url: `${root}/${collection}/${rest[0] ?? ""}`,
		accept: "application/json",
		render: compactChangeRequestMetadata,
	};
}

function registryRequest(resource: ParsedExternalResourceAddress): AdapterRequest {
	const name = resource.identifier;
	if (resource.scheme === "npm") {
		return {
			url: `https://registry.npmjs.org/${encodeURIComponent(name).replace("%2F", "%2f")}`,
			accept: "application/json",
			render: compactNpmMetadata,
		};
	}
	if (resource.scheme === "pypi") {
		return {
			url: `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
			accept: "application/json",
			render: compactPypiMetadata,
		};
	}
	if (resource.scheme === "crates") {
		return {
			url: `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
			accept: "application/json",
			render: compactCratesMetadata,
		};
	}
	return {
		url: `https://proxy.golang.org/${encodeGoProxyPath(resource.segments)}/@latest`,
		accept: "application/json",
		render: prettyJson,
	};
}

function resourceRequest(resource: ParsedExternalResourceAddress): AdapterRequest {
	if (resource.scheme === "github") return githubRequest(resource);
	if (resource.scheme === "gitlab") return gitlabRequest(resource);
	if (["npm", "pypi", "crates", "go-package"].includes(resource.scheme)) return registryRequest(resource);
	if (resource.scheme === "arxiv") {
		return {
			url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(resource.identifier)}`,
			accept: "application/atom+xml",
			render: (body) => decoder.decode(body),
		};
	}
	return {
		url: `https://api.osv.dev/v1/vulns/${encodeURIComponent(resource.identifier)}`,
		accept: "application/json",
		render: compactOsvVulnerability,
	};
}

function officialPageUrl(resource: ParsedExternalResourceAddress): string {
	if (resource.scheme === "github") {
		const [owner = "", repository = "", operation, ...rest] = resource.segments;
		const root = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
		if (operation === "file") return `${root}/blob/${encodePath(rest)}`;
		if (operation === "commit") return `${root}/commit/${encodeURIComponent(rest[0] ?? "")}`;
		if (operation === "pull") return `${root}/pull/${rest[0] ?? ""}`;
		if (operation === "issue") return `${root}/issues/${rest[0] ?? ""}`;
		if (operation === "diff") return `${root}/compare/${encodeURIComponent(rest[0] ?? "")}`;
		return root;
	}
	if (resource.scheme === "gitlab") {
		const operationIndex = resource.operationIndex ?? resource.segments.length;
		const operation = resource.operation;
		const rest = resource.segments.slice(operationIndex + 1);
		const root = `https://gitlab.com/${encodePath(resource.identifier.split("/"))}`;
		if (operation === "file") return `${root}/-/blob/${encodePath(rest)}`;
		if (operation === "commit") return `${root}/-/commit/${encodeURIComponent(rest[0] ?? "")}`;
		if (operation === "merge-request") return `${root}/-/merge_requests/${rest[0] ?? ""}`;
		if (operation === "issue") return `${root}/-/issues/${rest[0] ?? ""}`;
		return root;
	}
	if (resource.scheme === "npm") return `https://www.npmjs.com/package/${resource.identifier}`;
	if (resource.scheme === "pypi") return `https://pypi.org/project/${encodeURIComponent(resource.identifier)}/`;
	if (resource.scheme === "crates") return `https://crates.io/crates/${encodeURIComponent(resource.identifier)}`;
	if (resource.scheme === "go-package") return `https://pkg.go.dev/${encodePath(resource.segments)}`;
	if (resource.scheme === "arxiv") return `https://arxiv.org/abs/${encodePath(resource.segments)}`;
	return `https://osv.dev/vulnerability/${encodeURIComponent(resource.identifier)}`;
}

function officialHtmlRequest(url: string): AdapterRequest {
	return {
		url,
		accept: "text/html",
		render: (body, _contentType, finalUrl) => htmlToMarkdown(decoder.decode(body), finalUrl),
	};
}

function truncatedData(value: string | Uint8Array): { data: Uint8Array; truncated: boolean } {
	const data = typeof value === "string" ? encoder.encode(value) : value;
	if (data.length <= MAX_RENDERED_BYTES) return { data, truncated: false };
	return { data: data.subarray(0, MAX_RENDERED_BYTES), truncated: true };
}

async function executeRequest(
	sourceAddress: string,
	request: AdapterRequest,
	options: SourceAdapterOptions,
): Promise<ExternalResourceResult> {
	parseSafeHttpUrl(request.url);
	const response = await (options.cache ?? externalResourceCache).fetch(
		{
			url: request.url,
			headers: {
				Accept: request.accept,
				"Accept-Language": "en",
				"User-Agent": "pi-go-research/2.0 (+https://github.com/earendil-works/pi)",
			},
			maxBytes: MAX_STRUCTURED_BYTES,
			allowedContentTypes: ["text/", "application/json", "application/atom+xml", "application/xml"],
			...(options.signal ? { signal: options.signal } : {}),
			...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
		},
		options.fetcher,
	);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(
			`Official source request failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
		);
	}
	const rendered = truncatedData(await request.render(response.body, response.contentType, response.url));
	return {
		data: rendered.data,
		sourceAddress,
		finalUrl: response.url,
		contentType: request.accept.includes("diff") ? "text/x-diff; charset=utf-8" : "text/plain; charset=utf-8",
		cached: response.cached,
		readAt: response.readAt,
		truncated: rendered.truncated,
		untrusted: true,
		contentSha256: createHash("sha256").update(rendered.data).digest("hex"),
	};
}

export async function resolveExternalResource(
	address: string,
	options: SourceAdapterOptions = {},
): Promise<ExternalResourceResult> {
	const resource = parseExternalResourceAddress(address);
	try {
		return await executeRequest(resource.canonicalAddress, resourceRequest(resource), options);
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return executeRequest(resource.canonicalAddress, officialHtmlRequest(officialPageUrl(resource)), options);
	}
}

function githubAddress(url: URL): string | undefined {
	const [owner, repository, operation, identifier, ...rest] = url.pathname.split("/").filter(Boolean);
	if (!owner || !repository) return undefined;
	if (!operation) return `github://${owner}/${repository}`;
	if (operation === "blob" && identifier && rest.length > 0) {
		return `github://${owner}/${repository}/file/${identifier}/${rest.join("/")}`;
	}
	if (operation === "commit" && identifier) return `github://${owner}/${repository}/commit/${identifier}`;
	if (operation === "pull" && /^\d+$/.test(identifier ?? ""))
		return `github://${owner}/${repository}/pull/${identifier}`;
	if (operation === "issues" && /^\d+$/.test(identifier ?? ""))
		return `github://${owner}/${repository}/issue/${identifier}`;
	if (operation === "compare" && identifier?.includes("..."))
		return `github://${owner}/${repository}/diff/${identifier}`;
	return undefined;
}

function gitlabAddress(url: URL): string | undefined {
	const parts = url.pathname.split("/").filter(Boolean);
	const separator = parts.indexOf("-");
	if (parts.length < 2) return undefined;
	const project = parts.slice(0, separator < 0 ? parts.length : separator).join("/");
	if (separator < 0) return `gitlab://${project}`;
	const operation = parts[separator + 1];
	const identifier = parts[separator + 2];
	if (operation === "blob" && identifier && parts.length > separator + 3) {
		return `gitlab://${project}/-/file/${identifier}/${parts.slice(separator + 3).join("/")}`;
	}
	if (operation === "commit" && identifier) return `gitlab://${project}/-/commit/${identifier}`;
	if (operation === "merge_requests" && /^\d+$/.test(identifier ?? "")) {
		return `gitlab://${project}/-/merge-request/${identifier}`;
	}
	if (operation === "issues" && /^\d+$/.test(identifier ?? "")) return `gitlab://${project}/-/issue/${identifier}`;
	return undefined;
}

function addressForStructuredUrl(url: URL): string | undefined {
	const host = url.hostname.toLowerCase();
	if (host === "github.com") return githubAddress(url);
	if (host === "gitlab.com") return gitlabAddress(url);
	if (host === "www.npmjs.com") {
		const name = url.pathname.replace(/^\/package\//, "");
		if (name) return `npm://${name}`;
	}
	if (host === "pypi.org") {
		const name = /^\/project\/([^/]+)/.exec(url.pathname)?.[1];
		if (name) return `pypi://${name}`;
	}
	if (host === "crates.io") {
		const name = /^\/crates\/([^/]+)/.exec(url.pathname)?.[1];
		if (name) return `crates://${name}`;
	}
	if (host === "pkg.go.dev") {
		const module = url.pathname.replace(/^\//, "").split("@")[0];
		if (module) return `go-package://${module}`;
	}
	if (host === "arxiv.org") {
		const rawIdentifier = /^\/(?:abs|pdf)\/(.+)$/i.exec(url.pathname)?.[1];
		const identifier = rawIdentifier?.replace(/\.pdf$/i, "");
		if (identifier) return `arxiv://${identifier}`;
	}
	if (host === "osv.dev") {
		const identifier = /^\/vulnerability\/([^/]+)/.exec(url.pathname)?.[1];
		if (identifier) return `osv://${identifier}`;
	}
	return undefined;
}

function specialSiteRequest(url: URL): AdapterRequest | undefined {
	const host = url.hostname.toLowerCase();
	if (host === "stackoverflow.com") {
		const questionId = /^\/questions\/(\d+)/.exec(url.pathname)?.[1];
		if (questionId) {
			return {
				url: `https://api.stackexchange.com/2.3/questions/${questionId}?site=stackoverflow&filter=withbody`,
				accept: "application/json",
				render: compactStackOverflowQuestion,
			};
		}
	}
	if (host === "nvd.nist.gov") {
		const cve = /^\/vuln\/detail\/(CVE-\d{4}-\d{4,})$/i.exec(url.pathname)?.[1];
		if (cve) {
			return {
				url: `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cve)}`,
				accept: "application/json",
				render: compactNvdVulnerability,
			};
		}
	}
	if (host === "www.cisa.gov" && /known-exploited-vulnerabilities/i.test(url.pathname)) {
		const cve = url.searchParams.get("cve")?.toUpperCase();
		return {
			url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
			accept: "application/json",
			render: (body) => compactCisaCatalog(body, cve),
		};
	}
	if (
		host === "developer.mozilla.org" ||
		host === "docs.rs" ||
		host.endsWith(".readthedocs.io") ||
		host.endsWith(".readthedocs.org")
	) {
		return {
			url: url.toString(),
			accept: "text/html",
			render: (body, _contentType, finalUrl) => htmlToMarkdown(decoder.decode(body), finalUrl),
		};
	}
	return undefined;
}

export async function resolveStructuredWebUrl(
	value: string,
	options: SourceAdapterOptions = {},
): Promise<ExternalResourceResult | undefined> {
	const url = parseSafeHttpUrl(value);
	const address = addressForStructuredUrl(url);
	if (address) return resolveExternalResource(address, options);
	const request = specialSiteRequest(url);
	if (!request) return undefined;
	try {
		return await executeRequest(url.toString(), request, options);
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return executeRequest(url.toString(), officialHtmlRequest(url.toString()), options);
	}
}
