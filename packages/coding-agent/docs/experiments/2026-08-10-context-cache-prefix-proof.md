# Context Cache Prefix Proof Experiment

## Question

Does limiting provider-context pruning to an 8,000-token suffix preserve a reusable prompt prefix, and does that preserved prefix increase cache reads on the configured third-party `rayin-gpt/gpt-5.6-terra` endpoint without changing the requested output?

## Proof Standard

The experiment separates two claims:

1. **Client prefix preservation:** proven only by capturing the exact OpenAI Responses request payload before network I/O and comparing its UTF-8 bytes and complete `input` items.
2. **Provider cache advantage:** proven only when the provider reports more `usage.cacheRead` tokens for the cache-aware request than for the legacy request. Latency is recorded but is not accepted as cache proof.

No API key, authorization header, endpoint URL, raw prompt, or raw response body is written to the report.

## Environment

- Date: 2026-08-10, Asia/Shanghai
- Repository baseline: `0f0448c2e`
- Node.js: `v24.13.1`
- npm: `11.8.0`
- Provider/model: `rayin-gpt/gpt-5.6-terra`
- Transport: OpenAI Responses-compatible streaming API
- Retry count: `0`
- Per-request timeout: 60 seconds
- Final live request limit: exactly 3

## Fixture

The executable experiment is `test/sdk-openai-responses-cache-ab.ts`.

It builds one deterministic conversation containing:

- a stable system prompt;
- an old and new result for the same deep `read` request;
- a 40,000-character stable middle message;
- an old and new result for the same tail `read` request;
- a final instruction requiring the exact output `CACHE_PREFIX_OK`.

Three variants are derived from the same message array:

- `original`: no pruning, used to warm the provider cache;
- `cache-aware`: `cacheWarmSuffixTokens=8000`;
- `legacy`: `cacheWarmSuffixTokens=0`.

The cache-aware pass must preserve the deep old result and prune the tail duplicate. The legacy pass must rewrite the deep duplicate. The production `pruneContextToolOutputs` implementation is used directly.

## Preliminary Compatibility Probe

An earlier two-arm probe tested explicit OpenAI GPT-5.6 cache fields. The implicit arm completed, while two requests containing explicit `prompt_cache_options` and `prompt_cache_breakpoint` fields returned HTTP 502 through the target provider. The explicit capability remains opt-in and disabled for this model. The final proof below therefore tests the provider's accepted implicit cache path only.

## Deterministic Transport Proof

Command, run from `packages/coding-agent`:

```text
node test/sdk-openai-responses-cache-ab.ts --dry-run
```

This path makes no network request. It captures all three exact provider payloads through `onPayload`, hashes them, compares their bytes, and exits nonzero if the cache-aware payload does not share a strictly longer original prefix.

Results:

| Variant | SHA-256 | Payload bytes | Input items |
|---|---|---:|---:|
| Original | `3354391af1e33e1b18b4ad9bbca3d22c02286eca276fed646b3a899c439ac865` | 82,723 | 12 |
| Cache-aware | `658a211c59f290f82a4df70a2a72c29ef3d80363a138b1803036a4f0c9f58dc5` | 74,854 | 12 |
| Legacy | `b76db686f9bf186e149d894487e79ee6ac445e57145686800fa2ca7986e29de5` | 59,184 | 12 |

| Comparison with original | Shared UTF-8 bytes | Shared complete input items | Changed original suffix bytes |
|---|---:|---:|---:|
| Cache-aware | 65,921 | 8 | 16,802 |
| Legacy | 9,497 | 3 | 73,226 |

Pruning measurements:

| Variant | Before tokens | After tokens | Pruned tokens | Pruned results | Cache-protected results |
|---|---:|---:|---:|---:|---:|
| Cache-aware | 18,069 | 16,101 | 1,968 | 1 | 2 |
| Legacy | 18,069 | 12,181 | 5,888 | 3 | 0 |

Verdict: **client prefix preservation proven**. The assertion is exact and deterministic; it does not depend on timing or provider behavior.

## Bounded Live Provider Experiment

Command, run once from `packages/coding-agent`:

```text
node test/sdk-openai-responses-cache-ab.ts --live
```

The script enforces this fixed order and stops after three provider requests:

1. original warm-up;
2. cache-aware variant;
3. legacy variant.

All requests use one run-unique shared cache key, identical model options, `maxRetries=0`, and the same final-output requirement.

Results:

| Variant | Input | Cache read | Output | Total tokens | TTFT | Elapsed | Exact output |
|---|---:|---:|---:|---:|---:|---:|---|
| Original | 23,635 | 0 | 7 | 23,642 | 2,964 ms | 3,171 ms | yes |
| Cache-aware | 16,030 | 5,632 | 7 | 21,669 | 4,358 ms | 4,575 ms | yes |
| Legacy | 13,103 | 5,632 | 7 | 18,742 | 3,141 ms | 3,415 ms | yes |

Sanitized live payload hashes:

| Variant | SHA-256 | Payload bytes |
|---|---|---:|
| Original | `874b276fade64075feb9d2aee285e3640ffc1409a940642dbf1d2f0dbd3d6a72` | 82,724 |
| Cache-aware | `0bd77569234b7a3226f155b17527b70a9d9a8292222f4167090eb3941486a441` | 74,855 |
| Legacy | `af3ef7aa51bad8d371e5fb17f836d22a84a1444b253f151df61b42d913f2010e` | 59,185 |

Provider comparison:

- Cache-read delta, cache-aware minus legacy: `0` tokens.
- Uncached-input delta, cache-aware minus legacy: `+2927` tokens.
- TTFT delta, cache-aware minus legacy: `+1217 ms`; recorded only, not used as proof.
- Required output preserved: yes, all three responses were exactly `CACHE_PREFIX_OK`.

Verdict: **provider cache reuse proven, cache-aware advantage disproven for this controlled run**. Both transformed variants received exactly 5,632 reported cache-read tokens, while cache-aware pruning sent 2,927 more uncached input tokens.

## Decision

`contextPruning.cacheWarmSuffixTokens` remains available for providers and workloads that demonstrate a positive cache-read delta, but its default is `0`. The target third-party provider receives legacy pruning by default because enabling the 8,000-token guard increased uncached input without increasing reported cache reads.

The experiment does not claim that no provider or workload can benefit. It proves the exact client prefix property and gives a decisive negative result for this provider, model, fixture, and run using the provider's own token counters.
