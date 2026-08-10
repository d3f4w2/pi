# ADR-0041: Use One External Information Plane

## Status

Accepted

## Context

pi-go already has safe generic web extraction, a two-provider search fallback, a unified read path, and basic CDP browser control. Research still loses accuracy and tokens when an official repository, package, paper, documentation page, or vulnerability record is first discovered through generic search. Adding one model tool for every source would increase prompt size and tool-selection errors. Adding many low-quality search providers would increase latency and failure fan-out without improving source authority.

Browser element references are currently page-local strings without a snapshot version. Multi-tab navigation and asynchronous page changes would make those references unsafe. File upload, downloads, and attaching to an existing Chrome profile also introduce workspace and credential boundaries.

## Decision

1. Keep the model-visible surface limited to `web_search`, `read`, `grep`, and `browser`.
2. Add an ordered structured-source adapter registry behind research and unified read. Prefer official public APIs, then site parsers, generic extraction, and at most one search downgrade. Count an official first hit only after the adapter returns usable source content.
3. Add canonical read-only resource schemes for GitHub, GitLab, npm, PyPI, crates.io, Go modules, arXiv, and OSV.
4. Use one bounded, credential-free conditional cache for external resource bytes and metadata. Coalesce concurrent same-key fills. Expose source, time, content type, cache, truncation, hash, and trust state on every external result.
5. Let `grep` resolve and search textual resource addresses in memory. Do not expose external resolvers to write operations.
6. Extend the existing CDP browser tool with session-owned tabs and explicit operations. Require snapshot versions for element references and invalidate them on page changes.
7. Restrict uploads and downloads to workspace-controlled paths. Record page and failed-network errors without credentials or bodies.
8. Launch an isolated profile by default. Only an explicit safe loopback CDP setting may connect to an existing Chrome instance; no automatic profile or credential discovery is allowed.
9. Apply DNS-aware SSRF checks to top-level navigation and intercepted HTTP(S)/WebSocket requests. Loopback subresources require a matching explicitly navigated origin.
10. Project structured API responses to research-relevant fields before applying the final response cap; use explicit diff addresses when patch content is needed.

## Consequences

### Positive

- Official source data can be reached in one read/search decision instead of search-follow-fetch chains.
- New source families do not enlarge the model tool namespace.
- Canonical addresses are citeable, cacheable, grep-able, and independent of a search provider.
- One downgrade prevents repeated search spending during outages.
- Versioned references make multi-tab browser actions fail closed after page changes.
- Workspace path guards contain browser file I/O.

### Negative

- Public APIs have rate limits and response-shape drift that require adapter maintenance.
- A process-local cache does not survive restarts.
- Direct CDP implementation requires maintaining tab and event behavior without a browser automation dependency.
- Explicitly attaching to a user's Chrome can expose logged-in page content after the user opts in, even though pi-go never reads browser credential stores or cookie APIs.

### Neutral

- Generic web extraction remains the final content path for unrecognized sites.
- Optional Brave or future keyed search providers remain enhancements, not dependencies.
- The browser continues to use the user's installed Chromium executable while the default profile remains temporary and isolated.

## Alternatives Considered

### Add many search providers

Rejected. Provider count does not guarantee source authority, increases fallback latency, and conflicts with the three-call research target.

### Add one tool per external source

Rejected. It increases tool-schema tokens and selection ambiguity. Source differences belong behind one address/resolver contract.

### Copy Oh My Pi's handler and browser implementations

Rejected. pi-go keeps its existing extension, permission, SSRF, and CDP boundaries. Only the ordered-handler, internal-address, and stateful-tab capabilities are adopted.

### Permit arbitrary browser JavaScript

Rejected. Bounded named operations and versioned semantic references are easier to approve, test, and constrain.

### Automatically attach to the user's default Chrome profile

Rejected. It can expose cookies, passwords, history, extensions, and active sessions without an explicit user decision.

## References

- [External information plane architecture](../external-information-plane.md)
- [ADR-0012: bounded web isolation](0012-bounded-web-isolation.md)
- [ADR-0016: direct CDP browser control](0016-direct-cdp-browser-control.md)
- [Oh My Pi README](https://github.com/can1357/oh-my-pi)
