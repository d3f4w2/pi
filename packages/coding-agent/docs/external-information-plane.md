# External Information Plane

## Scope

The external information plane gives pi-go one bounded path for research, external resource reads, and interactive browser work. It extends the existing `web_search`, `read`, `grep`, and `browser` tools. It does not add one model-visible tool per website and it does not bypass MCP, plugin approval, sandbox, or tool-permission enforcement.

## Requirements

### Functional

- Resolve official developer, research, documentation, and vulnerability sources before generic web results.
- Read `github://`, `gitlab://`, `npm://`, `pypi://`, `crates://`, `go-package://`, `arxiv://`, and `osv://` addresses through the existing `read` tool.
- Search the text of an already resolved read-only resource through the existing `grep` tool.
- Keep all internet resources read-only.
- Add multi-tab navigation, bounded waits and interactions, workspace-only upload/download handling, page/network error summaries, and versioned snapshot references to the existing `browser` tool.

### Non-functional

- Official-source first-hit rate: at least 80% on the ten-question fixed benchmark.
- Ordinary research task: no more than three model-visible tool calls.
- Search fallback: at most one downgrade after the structured path fails.
- No provider requires an API key. Keyed providers remain optional enhancements.
- Every external result reports source address, read time, content type, cache state, truncation state, and untrusted-source state.
- Network reads keep the existing SSRF, redirect, timeout, content-type, and response-size boundaries.
- Cache entries never contain request credentials and remain bounded by count and bytes.
- Page snapshots, console/error output, downloads, and screenshots are bounded.

## Architecture

```text
research query
  -> deterministic source classifier
  -> official structured adapter
       -> success: structured citation result
       -> unavailable/failure: one generic search downgrade

read/grep resource address
  -> resource-address parser
  -> ordered source-adapter registry
  -> credential-free conditional cache
  -> SSRF-safe network transport
  -> structured/site-specific renderer
  -> generic HTML/text/PDF/archive materializer
  -> common metadata envelope

browser tool
  -> isolated browser launcher (default)
       -> explicit loopback CDP endpoint (opt-in only)
  -> session tab controller
  -> versioned semantic snapshot
  -> bounded navigation/wait/interaction operations
  -> workspace upload/download guard
  -> page and network failure recorder
```

## Research Engine 2.0

### Selection order

Each recognized source family follows one state machine:

1. Direct official API or structured endpoint.
2. Site-specific page parser when an API is unavailable or omits required text.
3. Existing generic webpage extraction.
4. One ordinary-search fallback.

The state machine stops on the first useful result. It records the attempted adapter and downgrade reason. It never loops through rewritten searches.

### Supported source families

| Family | Direct path | Site-specific fallback |
| --- | --- | --- |
| GitHub | REST repository, contents, commits, pulls, issues, compare | GitHub page/raw content |
| GitLab | public project/repository/commit/merge-request/issue API | GitLab page/raw content |
| npm | registry metadata | npm package page |
| PyPI | JSON metadata | project page |
| crates.io | crates API | crate page |
| Go modules | public module proxy | pkg.go.dev page |
| arXiv | export Atom API | abstract/PDF page |
| Stack Overflow | Stack Exchange API | question page |
| MDN | structured document page | readable page extraction |
| docs.rs | structured documentation page | readable page extraction |
| Read the Docs | project/version API when available | readable page extraction |
| OSV | vulnerability API | vulnerability page |
| NVD | CVE API | CVE detail page |
| CISA KEV | official JSON catalog | catalog page |

The first implementation uses only public endpoints. Optional credentials may improve rate limits later, but no adapter depends on them.

## Unified External Resource Addresses

Canonical forms:

```text
github://owner/repository
github://owner/repository/file/<ref>/<path>
github://owner/repository/commit/<sha>
github://owner/repository/pull/<number>
github://owner/repository/issue/<number>
github://owner/repository/diff/<base>...<head>
gitlab://namespace/project
gitlab://namespace/project/-/commit/<sha>
gitlab://namespace/project/-/merge-request/<number>
gitlab://namespace/project/-/issue/<number>
gitlab://namespace/project/-/file/<ref>/<path>
npm://package
pypi://package
crates://package
go-package://module/path
arxiv://paper-id
osv://vulnerability-id
```

The parser rejects credentials, fragments, empty identifiers, traversal segments, oversized components, and unsupported operations. GitLab requires the explicit `/-/` delimiter so nested namespaces cannot be mistaken for operations. Canonicalization removes representational duplicates before cache lookup.

`read` materializes the result. `grep` resolves the same address, requires textual output, and applies regex/literal matching with match, line, and byte limits. Write paths never call this resolver; external schemes remain read-only.

## Cache and Metadata

The cache is process-local and bounded. Its key is a SHA-256 digest of the canonical credential-free request identity and accepted representation. A successful response stores only:

- body bytes and body SHA-256;
- final public source URL;
- content type;
- ETag and Last-Modified when present;
- fetch time and expiry.

Fresh entries use a short TTL. Stale entries revalidate with `If-None-Match` or `If-Modified-Since`; a 304 refreshes the entry. Concurrent cold reads for the same key share one in-flight request and one cache write. Errors, credential-bearing URLs, authorization headers, and non-success responses are never cached. LRU eviction limits both entry count and total bytes.

Structured adapters project large API documents to source-specific fields before they reach the model. Package registries keep current release metadata instead of every historical version; code-host commit summaries omit patch bodies because explicit diff addresses remain available. The byte cap still applies after projection.

Every external result exposes:

```text
sourceAddress, readAt, contentType, cached, truncated,
untrusted, contentSha256
```

Model-facing text starts with an external-content warning and the same source facts. These fields are evidence metadata, not instructions from the source.

## Browser 2.0

### Session and tabs

The default launcher always creates a temporary isolated profile with extensions, sync, and background services disabled. `PI_BROWSER_CDP_URL` may explicitly select an already running loopback CDP endpoint. pi-go never auto-discovers an existing profile and never calls cookie, password, history, or credential APIs.

Top-level navigation and every intercepted HTTP(S)/WebSocket request are checked against the browser network policy. Literal private, link-local, metadata, local-suffix, and mixed public/private DNS answers fail closed. Loopback is allowed only after an explicit top-level navigation and only for the same origin. This blocks direct click, redirect, subresource, and WebSocket SSRF paths. CDP messages allow a 32 MB envelope while decoded screenshots remain capped at 20 MB.

The controller owns named tabs inside one browser process. It can list, create, switch, and close tabs, plus navigate, go back/forward, and reload the active tab.

### Versioned references

Each snapshot returns a monotonically increasing version. Element operations require both the element reference and that snapshot version. Navigation, controlled interaction, document replacement, or observed DOM changes invalidate the previous version. Validation occurs both in the controller and inside the page expression, so stale references fail before an action executes.

### Bounded operations

- Wait for a selector, visible text, URL substring, or network idle with a bounded timeout.
- Hover, press keys, select options, and upload files through snapshot references.
- Upload paths must resolve to regular files inside the active workspace and remain under per-file/count limits.
- Downloads use a fixed workspace subdirectory; callers cannot choose an arbitrary destination. Records and filesystem scans are bounded.
- Page exceptions and failed network requests are recorded without request headers or bodies.
- Screenshots support viewport and full-page modes with byte and dimension limits.

## Failure Modes

| Failure | Behavior |
| --- | --- |
| Official endpoint unavailable | One downgrade to generic search or page extraction |
| Rate limit/auth failure | Report adapter failure; do not request credentials or retry repeatedly |
| Redirect to private address | Reject before the next request |
| Oversized/malicious response | Stop reading, do not cache, preserve untrusted marker |
| Cache revalidation failure | Return error; do not silently serve expired security data |
| Stale browser reference | Reject before interaction and require a new snapshot |
| Upload outside workspace | Reject before CDP receives the path |
| Download path escape | Ignore/reject the record and keep the fixed download root |
| Explicit CDP endpoint absent | Launch the isolated profile |
| Explicit CDP endpoint unsafe | Reject; never fall back to scanning user Chrome |

## Quantitative Evaluation

The fixed ten-question benchmark covers repository state, a pull request, package versions, a Go module, an arXiv paper, Stack Overflow, MDN/docs.rs, and OSV/NVD/CISA vulnerability data. Each case records:

- expected official source family;
- whether the first attempt selected it;
- model-visible tool-call count;
- fixture latency;
- estimated input tokens from UTF-8 output bytes;
- cache state and response truncation.

Aggregate gates are official-source first-hit rate at least 80% and no more than three tool calls for an ordinary case. The benchmark uses fixed fixtures and a local server or injected transport; it makes no paid or live provider request.

### Recorded run: 2026-08-10

Commands:

```text
node node_modules/vitest/dist/cli.js --run test/research-engine-2.test.ts test/external-resources.test.ts --disableConsoleIntercept
node node_modules/vitest/dist/cli.js --run test/browser-2-integration.test.ts --disableConsoleIntercept
```

Environment: Windows, installed Chromium-family browser, loopback HTTP fixture, fixed/injected source fixtures, no paid API and no API key.

| Metric | Recorded result | Gate / interpretation |
| --- | ---: | --- |
| Verified official-source first hit | 10/10 (100%) | Pass, target >=80%; each fixture exercises the verifier contract |
| Mean model-visible research calls | 1.0 | Pass, target <=3 |
| Verified fixture p50 / p95 | 0.130 / 1.859 ms | Includes the injected verifier contract; excludes live network latency |
| Mean direct-result estimated input | 132.2 tokens | Includes the metadata envelope; UTF-8 bytes / 4 proxy, not provider billing data |
| Fixed eight-result generic baseline | 428 estimated tokens | Includes the same metadata envelope; excludes a later page fetch |
| Estimated input-token reduction | 69.11% | 132.2 versus 428 on the fixed result fixture |
| Ten-read resource cache hit rate | 90% | One cold read, nine fresh hits |
| Cache cold / mean hit latency | 30.546 / 0.019 ms | Fixed fetcher includes a 25 ms source delay; mean hit was about 1,598x faster |
| Cache source fetches | 1/10 | Nine requests avoided the source transport |
| Real Browser 2 fixture elapsed | 1,947 ms | 18 capability groups in one installed-browser run |
| Stale ref / outside upload | both rejected | Fail-closed checks observed in the real browser run |
| Viewport / full-page PNG | 2,150 / 2,150 bytes | Short fixture fits one viewport, so equal size is expected |

The ten-question benchmark deliberately measures high-confidence queries for which deterministic routing is valid. The injected verifier is a deterministic offline stand-in for the same contract used by the production adapter; separate adapter tests prove API success, cache, and page fallback behavior. A classifier match alone never counts as an official hit. It does not claim 100% on arbitrary natural-language research. Unrecognized queries still use the generic search path. The token figures are a reproducible approximation of text added to the next model input; exact provider tokenization and billing can differ.

## References

- [Oh My Pi README](https://github.com/can1357/oh-my-pi#twenty-three-backends-one-tool-the-agent-already-knows)
- [Oh My Pi development architecture](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/DEVELOPMENT.md)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
