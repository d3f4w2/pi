# Shared-Prefix Prompt-Cache Routing Proof

## Result

Project-scoped stable-prefix routing produced a real cache-token advantage on the configured `rayin-gpt/gpt-5.6-terra` endpoint in this bounded run.

Compared with a new session-scoped cache key, the optimized cross-session request:

- increased provider-reported cache reads from 3,840 to 8,960 tokens;
- reduced uncached input from 5,258 to 138 tokens, a 97.38% reduction;
- increased the cache-read rate from 42.21% to 98.48%, a 56.28 percentage-point gain;
- reduced time to first token from 3,714 ms to 3,578 ms, a 3.66% improvement;
- increased total elapsed time from 3,889 ms to 3,969 ms, a 2.06% regression.

All three responses were exactly `CACHE_ROUTE_OK`. The experiment proves a cache-routing and uncached-token advantage for this request. It does not prove a stable total-latency improvement from one three-request run.

## Question

Does replacing a per-session OpenAI Responses `prompt_cache_key` with Pi's project-scoped stable-prefix key increase real provider cache reuse across independent sessions without changing the prompt or result?

## Proof Standard

The experiment separates three claims:

1. **Payload isolation:** proven only when the final outbound payloads have one identical SHA-256 after replacing `prompt_cache_key` with a fixed marker.
2. **Routing advantage:** proven only when the optimized hit reports more `cacheRead` tokens and fewer uncached `input` tokens than the session-key control.
3. **Behavior preservation:** proven only when all responses match one exact required output.

Latency is recorded as a secondary metric. It is not used as evidence of cache reuse.

## Environment

- Date: 2026-08-10, Asia/Shanghai
- Repository baseline: `8616cfa39ee0d9478a0f7429a083e126981c6ffe`
- Node.js: `v24.13.1`
- npm: `11.8.0`
- Provider/model: `rayin-gpt/gpt-5.6-terra`
- Transport: OpenAI Responses-compatible streaming API
- Retry count: `0`
- Per-request timeout: 60 seconds
- Maximum output: 16 tokens per request
- Live request limit: exactly 3

## Design

The executable experiment is `test/sdk-openai-responses-shared-prefix-cache-ab.ts`.

It creates one run-unique system prompt of about 20 KB and sends the same context three times:

| Order | Variant | Cache key | Purpose |
| --- | --- | --- | --- |
| 1 | `optimized-warm` | stable-prefix key | Populate the optimized route |
| 2 | `session-key-control` | independent session key | Measure the old cross-session behavior |
| 3 | `optimized-hit` | same stable-prefix key as request 1 | Measure optimized cross-session reuse |

The run nonce is part of the prompt, preventing a previous execution of this experiment from prewarming the exact prompt. The control and optimized hit use different session IDs. The production `optimizeOpenAIResponsesPromptCache` function generates the optimized keys.

The order intentionally gives both measured requests one prior warm-up. The control is routed with a new session key; the optimized hit is routed back to the key warmed by request 1.

## Offline Payload Proof

Command, run from `packages/coding-agent`:

```text
node test/sdk-openai-responses-shared-prefix-cache-ab.ts --dry-run
```

The script intercepted the final requests before network I/O. The deterministic dry-run exited successfully with `verdict: proven`.

| Variant | Payload SHA-256 | Normalized SHA-256 | Cache-key SHA-256 | Bytes |
| --- | --- | --- | --- | ---: |
| Optimized warm | `ac931459819375081ec8a1c230ed0de50ef788258fc06af8e6e4f70c6bf24245` | `13e7fb110da63a05f6772029b200c93badb4aa5cd1b83b4110d545bd30c57905` | `5af499321c38382e964b2ae26ee01644cd3443f16becda70ea70ea7c6bd860bd` | 20,431 |
| Session-key control | `0e27313a471e31cabfffb6539d40fa0028538cc2a5eb3d95cd9d3a6a11dccd64` | `13e7fb110da63a05f6772029b200c93badb4aa5cd1b83b4110d545bd30c57905` | `38e1f87fcd0d2cf3b54baa7b8042eebd56774d64e80ad0b8b4ba152bbae0db8f` | 20,396 |
| Optimized hit | `ac931459819375081ec8a1c230ed0de50ef788258fc06af8e6e4f70c6bf24245` | `13e7fb110da63a05f6772029b200c93badb4aa5cd1b83b4110d545bd30c57905` | `5af499321c38382e964b2ae26ee01644cd3443f16becda70ea70ea7c6bd860bd` | 20,431 |

The normalized hashes prove that only `prompt_cache_key` differs. The optimized warm and hit key hashes are identical, while the control key hash is different. The raw keys, prompts, endpoint, credentials, and headers are not printed.

## Live Provider Experiment

Command, executed once from `packages/coding-agent`:

```text
node test/sdk-openai-responses-shared-prefix-cache-ab.ts --live
```

The script attempted and completed exactly three provider requests. No retry or second live run was performed.

Experiment ID SHA-256:

```text
b6a73e2d53d13e49a923c5b35675ee080c4d1de673d55a725eb5abfcd0e61d4f
```

All live payloads shared normalized SHA-256:

```text
108fda7ca56045f14821fa5dee462060184864257995adbefef2710b1cec831a
```

| Variant | Uncached input | Cache read | Prompt tokens | Cache-read rate | Output | TTFT | Elapsed | Exact output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Optimized warm | 5,258 | 3,840 | 9,098 | 42.21% | 7 | 3,798 ms | 3,864 ms | yes |
| Session-key control | 5,258 | 3,840 | 9,098 | 42.21% | 7 | 3,714 ms | 3,889 ms | yes |
| Optimized hit | 138 | 8,960 | 9,098 | 98.48% | 7 | 3,578 ms | 3,969 ms | yes |

Live payload evidence:

| Variant | Payload SHA-256 | Cache-key SHA-256 | Stable-shape SHA-256 |
| --- | --- | --- | --- |
| Optimized warm | `70a7f2609e6554d8e30e1a9f410ec5cb6a7a6ba0665775d9d7b532a2cb53e387` | `3e2abb009d9b8649d91ef050c8ed9f416289aa97ed5284ca2d4e03b2914a2cae` | `e6d73a71ce0ed5a27ea885870b004cac9fc30655e8ffd35a7cbf3d3a6bbe6939` |
| Session-key control | `7fc7929c5c9f5736a50e716b421d2f8b65d7865e9e0fb750b8276705fdc61f71` | `bc59da9748999835df31abee4db4e3413f44a0b8f47d64a2abfea18271cbe5ec` | `e6d73a71ce0ed5a27ea885870b004cac9fc30655e8ffd35a7cbf3d3a6bbe6939` |
| Optimized hit | `70a7f2609e6554d8e30e1a9f410ec5cb6a7a6ba0665775d9d7b532a2cb53e387` | `3e2abb009d9b8649d91ef050c8ed9f416289aa97ed5284ca2d4e03b2914a2cae` | `e6d73a71ce0ed5a27ea885870b004cac9fc30655e8ffd35a7cbf3d3a6bbe6939` |

## Calculations

For this provider adapter, prompt tokens are reported as uncached input plus cache-read tokens:

```text
control prompt tokens = 5,258 + 3,840 = 9,098
optimized prompt tokens = 138 + 8,960 = 9,098
```

The equal totals confirm that the optimization moved tokens from the uncached category to the cached category instead of shortening the prompt.

```text
cache-read lift = 8,960 - 3,840 = 5,120 tokens
uncached-input reduction = 5,258 - 138 = 5,120 tokens
uncached-input reduction rate = 5,120 / 5,258 = 97.38%
cache-read rate gain = 98.48% - 42.21% = 56.28 percentage points
TTFT improvement = (3,714 - 3,578) / 3,714 = 3.66%
elapsed change = (3,889 - 3,969) / 3,889 = -2.06%
```

The third-party provider's cached-token billing ratio is not established by this experiment, so the report does not translate the token movement into a monetary percentage. If cached and uncached tokens have different prices, the exact savings must use the provider's actual invoice rates.

## Repository Verification

- `node test/sdk-openai-responses-shared-prefix-cache-ab.ts --dry-run`: passed before and after the live run with identical deterministic hashes.
- Isolated `tsgo --noEmit` for the experiment entry point: passed.
- `npm run check:browser-smoke`: passed.
- Full `npm run check`: formatting, pinned dependencies, import rules, shrinkwrap, and install-lock checks passed. The repository-wide type phase was blocked by concurrent uncommitted memory-extension work under `packages/coding-agent/src/extensions/memory` and `packages/coding-agent/test/memory-storage.test.ts`. No diagnostic referenced this experiment or the cache-routing implementation.

The unrelated memory files were not modified intentionally, staged, or included with this experiment.

## Verdict

**Stable-prefix routing advantage proven for this provider, model, prompt, and run.** The only provider-payload difference was the cache key, and the optimized request moved 5,120 of 9,098 prompt tokens from uncached input to cache reads while preserving the exact response.

The primary optimization target—cache reuse and uncached-token consumption—improved substantially. TTFT improved slightly. Total request time did not improve in this single run, so latency should be evaluated over a larger sample only if the additional paid calls are acceptable.

## Limitations

- This is one bounded three-request run, chosen to respect the cost limit.
- Gateway load and network jitter can dominate latency measurements.
- The provider already reported 3,840 cached tokens for the control, likely from a prefix outside the run-specific portion; the stable key increased that to 8,960.
- The result proves this exact OpenAI Responses-compatible endpoint behavior, not every provider.
- No explicit cache breakpoint was used; that request shape previously returned 502 on this endpoint.

## Files

- Experiment runner: `test/sdk-openai-responses-shared-prefix-cache-ab.ts`
- Implementation plan: `docs/plans/2026-08-10-shared-prefix-cache-live-proof.md`
- Routing implementation: `src/core/prompt-cache-optimizer.ts`
- Architecture decision: `docs/adr/0031-shared-prefix-prompt-cache-routing.md`

## Reference

- [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
