# ADR-0031: Route Prompt Caches by Stable Project Prefix

## Status

Accepted

## Context

The coding agent previously used its unique session ID as the OpenAI Responses `prompt_cache_key`. That is stable within one session but different across resumed-independent sessions, even when those requests share the same project instructions, model, tools, and structured-output schema.

OpenAI documents that the key is combined with the prompt-prefix hash for routing and recommends reusing one key for requests that share a long common prefix. The provider still checks the exact prompt prefix before returning a cached result, so a shared routing key cannot return content from a different prompt.

The target third-party `gpt-5.6-terra` endpoint reports implicit cache reads but rejects explicit `prompt_cache_breakpoint` requests with 502. The optimization must therefore work with implicit caching, add no provider calls, preserve execution behavior, and avoid exposing project paths or prompt text in routing metadata.

Open-source comparison:

- OpenCode uses the session ID as `promptCacheKey` for the native OpenAI SDK, including custom providers. This establishes provider-aware key routing but does not share routing across separate sessions.
- Oh My Pi protects warm history from deep pruning and elides contextually useless tool results. Pi's measured cache-tail experiment found no cache-read benefit on the target provider, and Pi's built-in empty grep/find results are already shorter than the proposed elision notice.
- Aider can send periodic keepalive pings. That spends additional requests and conflicts with the requirement to reduce paid calls.

## Requirements

### Functional

- Reuse a cache-routing key across sessions with the same project, provider/model, system/developer prefix, tool definitions, and structured-output shape.
- Rotate the key when any of those stable inputs change.
- Exclude dynamic user and tool transcript tails from the key.
- Preserve an extension that explicitly changes or removes `prompt_cache_key`.
- Leave cache-disabled and non-OpenAI-Responses requests unchanged.

### Non-functional

- Do not change provider-visible prompt content, tools, tool order, history, or model settings.
- Do not make network requests or require cache support.
- Keep the key within OpenAI's 64-character limit.
- Do not expose prompt text, tool schemas, project paths, session IDs, or credentials in the key.
- Fail open on malformed or unsupported payloads.

## Decision

After the `before_provider_request` extension hook has produced the final payload:

1. Capture the provider-generated cache key before the hook.
2. If the extension changed or removed the key, return its payload unchanged.
3. For an OpenAI Responses payload with caching enabled, collect the stable cache shape:
   - resolved project scope;
   - provider, API, model ID, and request model;
   - top-level instructions;
   - leading system/developer input messages;
   - tool definitions in their final provider order;
   - structured-output configuration.
4. Serialize that shape and compute SHA-256.
5. Replace only the routing key with `pi-prefix-v1-` plus the first 48 hexadecimal digest characters.
6. Retain the original session ID elsewhere in the request path, including existing provider session-affinity headers.

The digest serves as both the shared routing key and an offline cache-shape fingerprint. The helper also returns the full digest and serialized byte count to tests without logging prompt contents.

## Data Flow

```text
provider payload
  -> before_provider_request extension
  -> extension-key ownership check
  -> stable-shape extraction
  -> SHA-256(project + model + system + tools + output schema)
  -> replace prompt_cache_key only
  -> provider transport
```

## Consequences

### Positive

- Separate tasks in the same project can be routed toward the same implicit prompt cache.
- Dynamic user messages do not rotate the key.
- Exact-prefix validation remains the provider's responsibility, so hash collisions cannot return an incorrect prompt state.
- Session affinity remains independent and extensions retain final control.
- No model call, cache keepalive, transcript mutation, or additional prompt token is introduced.

### Negative

- Requests sharing one project shape also share one routing key. OpenAI recommends approximately 15 requests per minute per key; traffic above that level may produce cache misses.
- A changed system prompt, tool schema, tool order, project scope, or output schema intentionally starts a new routing group.
- Proxies that ignore `prompt_cache_key` receive no benefit, although behavior remains unchanged.

### Neutral

- The project scope is hashed rather than transmitted in plaintext.
- The first 192 digest bits are transmitted; the full 256-bit digest remains local to diagnostics.
- This improves routing only. It cannot provide GPT-5.6 explicit-breakpoint semantics on a gateway that rejects breakpoint fields.

## Failure Modes and Mitigations

- Malformed payload: return the original object.
- Missing cache key: treat caching as disabled and return the original object.
- Unsupported API: return the original object.
- Extension-owned key: preserve it exactly.
- Provider ignores the key: normal implicit caching and execution continue.
- High request rate on one key: cache hits may fall; deployments can use `before_provider_request` to supply a more granular key without code changes.

## Alternatives Considered

### Keep session-only cache keys

Rejected as the default because identical project prefixes cannot share routing across new sessions. The session ID remains available for transport affinity.

### Use one global key

Rejected because unrelated projects and prompt shapes would create a traffic hotspot and route to a cache that cannot match their exact prefixes.

### Include the entire transcript in the key

Rejected because every turn would rotate the key and defeat routing reuse.

### Send raw project or prompt identifiers

Rejected because routing metadata should not disclose local paths or prompt contents.

### Add cache keepalive requests

Rejected because they spend paid calls and can cost more than the eviction they avoid.

### Enable cache-aware deep-pruning protection

Rejected as the default after the target-provider experiment reported equal cache reads and 2,927 more uncached input tokens with the guard.

## Verification

The focused offline suite proves:

- different session keys and user tails converge on one shared key;
- project, model, system, tool, and output-schema changes rotate it;
- unsupported, disabled, and malformed requests fail open;
- the SDK applies the shared key;
- extensions can retain an explicitly owned key;
- the key contains no raw scope or prompt text and remains below 64 characters.

## References

- [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenCode cache-key tests](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/test/provider/transform.test.ts)
- [Oh My Pi cache-aware pruning](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/src/compaction/pruning.ts)
- [Aider cache settings](https://github.com/Aider-AI/aider/blob/main/aider/website/assets/sample.aider.conf.yml)
- [ADR-0030: Bound Context Pruning to the Prompt-Cache Tail](0030-cache-aware-context-pruning.md)
