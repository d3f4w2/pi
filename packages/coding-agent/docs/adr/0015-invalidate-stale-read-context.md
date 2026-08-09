# ADR-0015: Invalidate Stale Read Results After File Mutations

## Status

Accepted

## Context

Provider-only context hygiene already removes large or superseded tool output. However, a `read` result can remain in model context after a later successful `edit` or `write` changes the same file. Keeping that source verbatim wastes tokens and can cause the model to reason from obsolete code.

Skipping filesystem reads through a cache would require reliable external-change detection and could return stale data. The important correctness problem is not local read latency; it is obsolete content sent to the model.

## Decision

During the existing newest-to-oldest context-hygiene pass:

- track normalized paths from successful `edit` and `write` results;
- replace older same-path `read` content with a deterministic invalidation notice;
- keep later reads verbatim;
- ignore failed mutations, unmatched paths, `bash`, and unknown tools;
- keep the persisted session unchanged.

## Consequences

### Positive

- The model is less likely to use obsolete code.
- Stale source stops consuming provider tokens.
- No file reads, model calls, dependencies, or background work are added.
- Exact path matching preserves unrelated read results.

### Negative

- A model that needs the old version must recover it from history or version control.
- Mutations performed through `bash` cannot be identified safely and remain fail-open.
- Lexically different paths to the same file may not match.

### Neutral

- The feature improves provider context but does not skip actual `read` tool execution.
- Existing recent-token protection still applies to current, non-stale results.

## Alternatives Considered

### Cache and reuse read output

Rejected because external file changes make cache correctness expensive and fragile.

### Invalidate every read after any mutation

Rejected because it would unnecessarily reduce recall for unrelated files.

### Infer writes from arbitrary terminal commands

Rejected because shell command effects cannot be classified reliably without executing a filesystem transaction monitor.

## References

- [Context Hygiene Architecture](../context-hygiene-architecture.md)
- [Stale Read Design](../plans/2026-08-09-context-hygiene-stale-read-design.md)
