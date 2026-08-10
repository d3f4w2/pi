# ADR-0040: Keep Transient Gateway Retries Cache-Local

## Status

Accepted

## Context

The post-routing live trace reached 12,800 cache-read tokens out of 13,194 prompt tokens on its warm request, or 97.01%. The next request failed before streaming with an empty HTTP 502 response. AgentSession recovered 9.18 seconds later, but the replacement request reached a cold provider route and reported zero cache reads.

The existing provider helper could retry transient setup failures, while AgentSession separately retried failed model turns. Running both policies independently could exceed the intended request budget. Surfacing every first 502 to AgentSession also lengthens recovery and gives the gateway another opportunity to choose a different cache shard.

## Decision

Pi will preserve cache locality during transient OpenAI Responses setup failures as follows:

1. If the caller did not set a provider retry count, retry at most once for a statusless transport failure or HTTP 502, 503, or 504.
2. Reuse the already transformed request parameters. The retry changes neither the prompt, cache route, tools, model options, nor provider headers.
3. Do not apply this default retry to HTTP 429. Explicit caller retry settings retain the existing generic transient-error policy.
4. Record only the number of consumed attempts and whether the provider retry recovered or failed. Do not record error messages, payload text, endpoints, or credentials.
5. Count provider-layer attempts against AgentSession's existing retry budget. Cap an explicit provider retry count to the remaining outer budget. During an outer AgentSession retry, disable the provider retry loop so retry layers cannot multiply.
6. Report first successful response and subsequent successful response cache-read rates separately. Failed responses with no prompt usage do not consume the first-response bucket.

## Consequences

### Positive

- A single transient gateway failure can recover before the stream reaches AgentSession.
- The second HTTP attempt has the same serialized body and headers in the pinned SDK path, preserving every client-controlled cache input.
- The maximum enabled AgentSession retry budget does not increase, even when the provider setting requests more attempts.
- Cold-start behavior no longer hides warm-turn cache performance in one aggregate.

### Negative

- A failed request may have executed remotely even when no stream arrived, so any retry can still duplicate provider work or billing.
- A gateway can fail over to a cold cache shard despite an identical payload; client code cannot guarantee provider-side cache placement.
- One provider-layer retry adds delay before AgentSession exposes the failure or starts its own retry.

### Neutral

- The model-visible request and execution semantics are unchanged.
- Third-party Responses gateways remain stateless and use implicit caching unless their compatibility metadata explicitly enables another path.
- Rate-limit policy remains caller-controlled because an automatic 429 retry can increase cost without improving cache locality.

## Alternatives

### Use six transport attempts like oh-my-pi's default helper

Rejected because it can spend substantially more third-party quota during an outage. One cache-local attempt addresses the observed single 502 while retaining the user's bounded total retry policy.

### Rely only on AgentSession retries

Rejected because the failure crosses an extra lifecycle boundary before resending the same turn and can lose the original gateway connection or shard affinity.

### Enable explicit breakpoints or stateful continuation on the configured gateway

Rejected because the gateway previously returned HTTP 502 for the explicit breakpoint probe and publishes no compatible response-state contract. Unsupported fields must not be enabled by inference.

## References

- [ADR-0031: Route Prompt Caches by Stable Project Prefix](0031-shared-prefix-prompt-cache-routing.md)
- [ADR-0035: Use an Adaptive, Fail-Open Cache Runtime](0035-adaptive-cache-runtime.md)
- [oh-my-pi OpenAI Responses provider](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/providers/openai-responses.ts)
- [oh-my-pi OpenAI HTTP retry helper](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/utils/openai-http.ts)
