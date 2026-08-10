# Prompt Cache Runtime

Pi's cache runtime optimizes exact request prefixes without treating cache hits as a correctness requirement. Unsupported fields, ambiguous prompt transformations, observer failures, and continuation failures all fall back to the original full request.

## Request path

1. Build the stable base system prompt and tool schemas.
2. Convert an exact appended extension suffix into a persisted developer-context revision. Replacement and prepending are left unchanged.
3. Derive a project-private route key from the stable base, model, tools, and output shape.
4. On explicitly compatible providers, select the stable system boundary and up to three recent text boundaries whose estimated reuse value exceeds their write premium.
5. Record only per-item hashes, byte counts, decisions, request timing, and provider usage; the runtime does not retain serialized prompt or output text.
6. On opted-in official OpenAI sessions, use a response handle only when hashes for the previously covered request plus response are an exact prefix of the current input and the hashed non-input request shape is unchanged.
7. Before a response stream starts, retry one transient gateway setup failure with the same transformed request. That provider-layer attempt consumes the same total retry budget as outer AgentSession retries.

## Safety rules

- Model-visible extension suffix bytes are not summarized or reordered.
- The dynamic-developer sentinel is private to the local transcript and removed before the provider request.
- A changed or removed suffix emits an explicit developer revocation so stale revisions cannot remain active.
- Explicit breakpoint syntax is sent only when both compatibility flags are true.
- At most four breakpoint writes are requested in one call.
- Automatic threshold compaction can be deferred once; overflow and manual compaction cannot.
- Official stateful continuation is opt-in, requires `store: true`, and retries the complete stateless payload on setup failure.
- The default gateway retry applies only to statusless transport failures and HTTP 502, 503, or 504. It does not automatically retry HTTP 429, and outer retries cannot recursively start another provider retry loop.
- Reports never contain project paths, prompt text, tool descriptions, or credentials.

## Report fields

The session report exposes request and response counts, actual provider cache-read ratio, separate first-response and subsequent-response cache-read ratios, exact-prefix continuity, cache-route and shape changes, breakpoint decisions, estimated cache savings, continuation attempts/fallbacks, provider retry attempts/recoveries/failures, compaction deferrals, and local conversion memo hits. These are separate metrics: a high byte-prefix ratio does not prove the provider served a cache hit, while `usage.cacheRead` does.
