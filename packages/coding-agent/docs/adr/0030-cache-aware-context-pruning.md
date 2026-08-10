# ADR-0030: Bound Context Pruning to the Prompt-Cache Tail

## Status

Accepted

## Context

Provider-only context hygiene can save input tokens by replacing an old tool result. The replacement also changes every prompt byte after that result. For example, saving 8,000 tokens from one deep result can invalidate more than 200,000 tokens of an otherwise reusable prompt-cache prefix.

The existing 40,000-token recency window counts tool output only. It does not bound the complete message suffix that a provider must recompute, and exact duplicate results inside a small cache tail cannot clear the 8,000-token aggregate savings floor.

## Decision

- Compute the estimated suffix from every provider-visible message.
- Keep the guard disabled by default because the target provider experiment showed no cache-read advantage and higher uncached input.
- When configured to a positive value such as 8,000, only rewrite a tool result when at most that many estimated tokens follow it.
- Allow an exact superseded result inside that tail to bypass the tool-output recency window and aggregate savings floor because a newer result for the identical request remains available.
- Keep unique results subject to the existing recency, result-size, and aggregate-savings rules.
- Let a read proven stale by a later successful `edit` or `write` bypass the cache guard because correctness takes priority over cache reuse.
- Let users set `contextPruning.cacheWarmSuffixTokens` to `0` to use the default legacy unbounded behavior.

## Consequences

### Positive

- When enabled, routine pruning cannot unexpectedly rewrite a large warm prompt-cache prefix.
- The guard accounts for user and assistant messages, not only tool results.
- Read-edit-read loops can still remove the immediately superseded read.
- No provider feature, model call, network request, or persisted transcript mutation is introduced.

### Negative

- Deep redundant results remain in provider input until normal compaction rebuilds the context.
- On cacheless providers, the default can send more uncached input than the legacy policy.
- Token estimates remain approximate.

## Experiment

A synthetic 120-call read loop contained about 241,280 estimated tokens. With the 8,000-token guard, pruning changed 2 results, saved about 3,936 tokens, and the deepest changed result had about 6,033 tokens after it. With the guard disabled, pruning changed 110 results and saved about 213,200 tokens, but the deepest change had about 239,270 tokens after it. Transform time was about 1.08ms versus 0.64ms on the development machine.

The deterministic transport proof captured the exact OpenAI Responses payload. The guarded request shared 65,921 UTF-8 bytes and 8 complete input items with the original warm-up payload; legacy pruning shared 9,497 bytes and 3 items. This proves the client property.

The bounded live experiment sent exactly three requests to `rayin-gpt/gpt-5.6-terra`: original warm-up, guarded, then legacy. Both transformed variants reported 5,632 cache-read tokens. The guarded request reported 16,030 uncached input tokens and legacy reported 13,103. The guard therefore produced no cache-read advantage and added 2,927 uncached input tokens in this experiment. All three requests returned the required exact output. Latency was recorded but not used as cache proof.

The [complete experiment record](../experiments/2026-08-10-context-cache-prefix-proof.md) contains commands, hashes, measurements, limits, and the distinction between client proof and provider evidence.

## Alternatives Considered

### Keep unbounded pruning and rely on minimum savings

Rejected because the minimum saving does not bound the much larger suffix invalidated by a deep replacement.

### Disable context pruning entirely

Rejected because exact duplicates and correctness-critical stale reads can still be removed safely inside the bounded tail.

### Track provider TTL and warm state per session

Deferred because provider and proxy TTLs differ, cache accounting may be unavailable, and session state would add failure modes. The deterministic suffix boundary is provider-independent and testable offline.

## References

- [Context Hygiene Architecture](../context-hygiene-architecture.md)
- [ADR-0002](0002-provider-only-context-hygiene.md)
- [Oh My Pi cache-aware pruning](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/src/compaction/pruning.ts)
