# Segmented Prompt-Cache Live Proof

## Result

The segmented-cache implementation is proven offline, but the configured `rayin-gpt/gpt-5.6-terra` endpoint rejected the explicit GPT-5.6 request shape with HTTP 502.

The bounded live run attempted two of the permitted three requests:

1. The implicit control succeeded and returned exactly `CACHE_SEGMENT_OK`.
2. The explicit warm request returned `502 status code (no body)`.
3. The explicit hit was not sent because the experiment disables retries and stops at the first provider error.

This proves the provider compatibility boundary, not a cache-performance improvement on this endpoint. Pi must keep this third-party model on implicit caching. Official OpenAI GPT-5.6 and third-party models whose compatibility metadata explicitly enables both capabilities can use the segmented path.

## Question

Can Pi preserve a stable system prefix while both a dynamic extension suffix and the user message change, place an explicit GPT-5.6 cache breakpoint at that stable boundary, and obtain a real cache hit through the configured third-party provider?

## Proof Standard

The experiment separates four claims:

1. **Text preservation:** the concatenated provider system content must equal the original effective system prompt.
2. **Boundary correctness:** the explicit breakpoint byte offset must equal the stable-prefix byte count.
3. **Dynamic isolation:** explicit warm and hit must share a route key and stable-prefix hash while their full system-prompt hashes and user messages differ.
4. **Live reuse:** the explicit hit must report more cache reads and less uncached input than the explicit warm request.

Claims 1–3 were proven offline. Claim 4 could not be evaluated because the provider rejected the explicit warm request.

## Environment

- Date: 2026-08-10, Asia/Shanghai
- Repository baseline: `60aeae3eacdf706fa63017b7c5a7b89fa4c6b49e`
- Node.js: `v24.13.1`
- npm: `11.8.0`
- Provider/model: `rayin-gpt/gpt-5.6-terra`
- Transport: OpenAI Responses-compatible streaming API
- Retry count: `0`
- Request timeout: 60 seconds
- Maximum output: 16 tokens
- Paid request limit: 3
- Actual attempts: 2

No endpoint, credential, raw prompt, session ID, or cache key is recorded. Identifiers are represented by SHA-256 digests.

## Implementation Under Test

The production optimizer now receives the exact base system prompt from `AgentSession`. If the effective prompt starts with that base, routing excludes the dynamic suffix. When both provider compatibility flags are enabled, the optimizer splits the already serialized system/developer text and places `prompt_cache_breakpoint` at the end of the base.

The full provider-visible text remains:

```text
stable base + dynamic system suffix + conversation/user suffix
```

Only the content-block representation and cache metadata change.

## Experiment Design

The executable runner is `test/sdk-openai-responses-segmented-cache-ab.ts`.

It creates a run-unique stable system prefix and two dynamic variants:

| Order | Variant | Dynamic suffix | Cache mode | Purpose |
| --- | --- | --- | --- | --- |
| 1 | implicit control | B | provider implicit | Same model-visible request as the planned explicit hit |
| 2 | explicit warm | A | explicit breakpoint | Populate only the stable base |
| 3 | explicit hit | B | explicit breakpoint | Read the base despite changed system and user suffixes |

The control and explicit hit have identical canonical model-visible payload hashes. The explicit warm and hit have different full prompt hashes but share one stable-prefix hash and one optimized key.

The live runner force-enables the two explicit compatibility flags only for the two experimental variants. Production configuration for the third-party model remains unchanged.

## Offline Proof

Command, run from `packages/coding-agent`:

```text
node test/sdk-openai-responses-segmented-cache-ab.ts --dry-run
```

The deterministic dry run exited successfully with `verdict: proven`.

| Evidence | Result |
| --- | --- |
| Stable system prefix | 22,338 bytes in deterministic dry run |
| Dynamic system suffix | 43 bytes |
| Explicit breakpoint offsets | exactly 22,338 bytes for warm and hit |
| Stable-prefix hashes | identical across all three variants |
| Full-system hashes | warm differs from control/hit |
| Explicit routing keys | warm and hit share one 61-character key |
| Model-visible payload | control and hit SHA-256 both `b9c25a22ddcad6519164490b2fe7656a024b651c96b556e368b5d38cea6d944a` |
| Prompt size | every serialized request exceeds 22 KB |

The dry run captures the final payload through the real OpenAI Responses serializer and production cache optimizer before network I/O.

## Live Provider Run

Command, executed once from `packages/coding-agent`:

```text
node test/sdk-openai-responses-segmented-cache-ab.ts --live
```

Experiment ID SHA-256:

```text
e1c90284f648da1659a67b0108d32d4a52f380aa961d4bad6a08ca4a9442a12f
```

The run-specific stable prefix was 22,364 bytes; the dynamic suffix remained 43 bytes. The offline proof embedded in the live run again showed both explicit breakpoints at byte 22,364 and one shared explicit key.

### Completed implicit control

| Metric | Value |
| --- | ---: |
| Uncached input | 5,849 tokens |
| Cache read | 3,840 tokens |
| Cache write reported | 0 tokens |
| Total prompt | 9,689 tokens |
| Cache-read rate | 39.63% |
| Output | 8 tokens |
| TTFT | 6,121 ms |
| Elapsed | 6,238 ms |
| Exact output | yes |

The equal expected output proves normal execution remained intact on the implicit path.

### Explicit warm rejection

The next request contained:

- `prompt_cache_options: { mode: "explicit", ttl: "30m" }`;
- a content block with `prompt_cache_breakpoint: { mode: "explicit" }` at the exact stable boundary;
- the same provider, model, reasoning, output limit, and stable prefix.

The endpoint returned:

```text
OpenAI API error (502): 502 status code (no body)
```

Because the response had no body, it cannot distinguish whether the gateway rejected `prompt_cache_options`, `prompt_cache_breakpoint`, or failed while forwarding the explicit request. The earlier breakpoint-only experiment produced the same status, so the evidence is consistent with unsupported explicit caching.

## Verdict

**Offline segmented serialization: proven. Live explicit caching on `rayin-gpt/gpt-5.6-terra`: unsupported by observed behavior.**

No cache-read lift, uncached-input reduction, or latency improvement can be claimed for changing dynamic suffixes on this provider because the cacheable explicit request never completed. The production capability gate is therefore necessary and remains closed for this third-party model.

The successful implicit control still confirms that existing execution behavior and implicit caching remain available: 3,840 of 9,689 prompt tokens were reported as cache reads.

## Cost and Request Bound

- Maximum authorized attempts: 3
- Actual attempts: 2
- Automatic retries: 0
- Requests after first error: 0

The unused third request was intentionally not spent because one additional cold implicit request could not prove dynamic-prefix reuse without another warm request.

The gateway's actual billing rates are not available in this experiment, so the report does not convert token counts to money.

## Repository Verification

- `test/prompt-cache-optimizer.test.ts`: 10 passed.
- `test/cache-stats.test.ts`: 11 passed.
- `test/cache-retention.test.ts`: 19 passed, 4 existing credential-gated cases skipped.
- `test/openai-responses-compat.test.ts`: 35 passed.
- Total focused result: 75 passed, 4 skipped, 0 failed.
- `node test/sdk-openai-responses-segmented-cache-ab.ts --dry-run`: passed again after the report was written with the deterministic hashes recorded above.
- `npm run check`: passed formatting, pinned dependencies, TypeScript import rules, shrinkwrap, install lock, repository-wide `tsgo --noEmit`, and browser smoke checks.

The full test suite was not run because repository instructions reserve it for explicit requests and it includes credential-sensitive end-to-end cases. Concurrent memory/evaluation work in the shared working tree was not edited or included in the cache implementation.

## Limitations

- One live compatibility probe cannot establish behavior for other gateways or future gateway versions.
- HTTP 502 without a body does not identify the exact rejected field.
- Latency for the failed request is not comparable to model TTFT.
- Official OpenAI GPT-5.6 capability is enabled from model metadata but was not called because this experiment used the user's configured third-party API.
- Hot-key sharding remains disabled because this run is far below the documented traffic threshold.

## Files

- Architecture: `docs/prompt-cache-architecture.md`
- Decision: `docs/adr/0032-segmented-explicit-prompt-cache.md`
- Plan: `docs/plans/2026-08-10-segmented-prompt-cache.md`
- Runner: `test/sdk-openai-responses-segmented-cache-ab.ts`
- Optimizer: `src/core/prompt-cache-optimizer.ts`

## References

- [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Previous shared-prefix routing proof](2026-08-10-shared-prefix-cache-routing-proof.md)
