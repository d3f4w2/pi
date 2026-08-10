# ADR-0035: Use an Adaptive, Fail-Open Cache Runtime

## Status

Accepted

## Context

ADR-0031 introduced stable request-shape routing and ADR-0032 split the stable system prefix from dynamic suffixes. Eight real long coding sessions still showed 75.02% weighted cache reads, with a heuristic 9.87% of prompt tokens exposed by avoidable prefix gaps. The remaining losses mainly come from rewriting dynamic developer state, relying on one early breakpoint, compacting a warm history, repeatedly preparing the same local messages, and replaying complete Responses inputs.

The configured third-party GPT-5.6 endpoint accepts implicit prompt caching but rejected explicit breakpoint syntax with HTTP 502. Any deeper optimization therefore needs provider gates and a stateless fallback.

## Decision

Pi will use a session-local cache runtime with these invariants:

1. Exact suffix-only `before_agent_start` changes are stored as append-only developer-context revisions while the system prompt remains the exact stable base. A changed or removed suffix revokes the previous revision; replacement or prepending keeps the existing full-system behavior.
2. OpenAI Responses payloads may contain the stable system breakpoint plus at most three recent eligible text boundaries. A price-based gate suppresses breakpoints whose estimated next-read saving does not exceed their write premium.
3. A privacy-safe flight recorder joins request-shape evidence with reported provider usage and exposes actual cache-read rate, prefix continuity, estimated savings, drift causes, and compaction decisions.
4. Threshold compaction may be deferred once when reuse is measured as warm and enough hard output headroom remains. Overflow recovery and manual compaction are never deferred.
5. Completed local message conversions are memoized only while their mutation-sensitive identity is unchanged.
6. Official OpenAI Responses sessions may opt into stateful continuation. It uses `previous_response_id` only after exact covered-prefix and request-shape equality. Any mismatch uses a full request; continuation failures retry the full request and open a three-strike circuit breaker.
7. Third-party endpoints remain stateless unless their existing compatibility metadata explicitly enables a feature. Diagnostic, memoization, and optimization failures always preserve the original request.

## Consequences

### Positive

- Dynamic task, memory, and learning state no longer rewrites the first request segment when it only appends to the base prompt.
- Recent history can be reused at more than the system boundary without exceeding GPT-5.6's four-new-write limit.
- Cache claims can be checked against both exact request continuity and provider-reported usage.
- Official Responses continuation reduces upload and serialization work while cache billing remains visible separately.
- Every risky path has an immediate stateless fallback.

### Negative

- Append-only developer revisions remain in context until compaction and consume tokens.
- Extra explicit breakpoints can create write cost, so provider pricing and compatibility metadata must be accurate.
- Stateful continuation requires provider storage and is therefore opt-in and official-OpenAI-only.
- One-turn compaction deferral trades a small amount of headroom for cache continuity.

### Neutral

- Stateful continuation does not reduce the number of input tokens billed by OpenAI; it targets request upload and latency.
- The third-party GPT-5.6 endpoint continues to use implicit caching.
- A model or tool-shape change rotates the route and disables continuation for that request.

## Alternatives

### Rewrite every dynamic system suffix in place

Rejected because exact-prefix caches stop at the first changed byte.

### Always add four breakpoints

Rejected because the extra cache writes can cost more than the expected reuse.

### Defer every warm-cache compaction

Rejected because preserving a cache is not worth a context overflow.

### Enable `previous_response_id` for compatible gateways

Rejected because third-party storage, response lifetime, and fallback semantics are not uniform.

## References

- [ADR-0031: Route Prompt Caches by Stable Project Prefix](0031-shared-prefix-prompt-cache-routing.md)
- [ADR-0032: Segment Stable System Prompts for Explicit Caching](0032-segmented-explicit-prompt-cache.md)
- [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state)
