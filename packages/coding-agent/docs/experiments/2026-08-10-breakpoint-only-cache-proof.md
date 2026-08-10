# Breakpoint-Only Prompt Cache Experiment

## Result

Do not enable `prompt_cache_breakpoint` for the configured `rayin-gpt/gpt-5.6-terra` endpoint.

The client-side proof passed, but the first live request containing one `prompt_cache_breakpoint` and no `prompt_cache_options` returned `502 status code (no body)`. The run stopped immediately, so it made one paid request rather than the allowed maximum of three.

This proves the current integration cannot safely deploy the field: the exact request shape Pi would send did not complete. It does not prove that the upstream model or every future version of the proxy permanently lacks breakpoint support; the proxy returned no diagnostic body, so a transient upstream failure cannot be excluded from one observation.

## Question

An earlier probe sent `prompt_cache_breakpoint` together with `prompt_cache_options` and received `502`. That did not identify which extension the third-party endpoint rejected.

The isolated question was:

> Does the endpoint accept `prompt_cache_breakpoint` while remaining in the default implicit cache mode, and if so does it report more cached input than an otherwise equivalent implicit control?

OpenAI's prompt-caching guide documents that implicit caching is the default, explicit breakpoints can be added to Responses API `input_text` blocks, and `prompt_cache_options` is required only when disabling implicit mode. The experiment therefore removed `prompt_cache_options` from every request and changed only the system-content representation and breakpoint marker.

## Safety and Cost Bound

- Default mode is dry-run and performs no network I/O.
- Live mode permits exactly three variants.
- SDK retries are disabled with `maxRetries: 0`.
- Each request has a 60-second timeout and a 32-token output cap.
- The loop stops after the first provider error.
- Prompts, credentials, base URLs, headers, and the raw cache key are not printed.
- The live run used one provider request because the first request failed.

## Request Design

All variants use the same run-unique session/cache key and the same 19,269-byte stable system prefix. Only the user suffix and breakpoint treatment differ.

| Order | Variant | System breakpoint | Purpose |
| --- | --- | --- | --- |
| 1 | `breakpoint-warm` | one explicit marker | populate the breakpoint cache |
| 2 | `breakpoint-hit` | one explicit marker | measure breakpoint reuse |
| 3 | `implicit-control` | none | compare default implicit caching |

The required assistant output is exactly `BREAKPOINT_ONLY_OK`. A different output fails the measurement instead of being treated as valid evidence.

## Reproduction

From `packages/coding-agent`:

```powershell
node test/sdk-openai-responses-breakpoint-only-ab.ts --dry-run
node test/sdk-openai-responses-breakpoint-only-ab.ts --live
```

The first command is safe and offline. The second command uses the locally configured provider credentials and can make up to three paid requests.

## Offline Payload Proof

The dry-run intercepted the final OpenAI Responses payload inside `onPayload` and threw before the transport performed network I/O.

| Variant | Payload SHA-256 | Bytes | Stable prefix SHA-256 | Breakpoints | `prompt_cache_options` |
| --- | --- | ---: | --- | ---: | --- |
| `breakpoint-warm` | `2e38ad3714fab936b3624f482839960694e1ec6e67bf55d0ea5c3aa8c99f2ae1` | 19,915 | `e1096a6a18db10c06c1c99d895e898214dd6f2f4cd5b10be0454d636422d9c29` | 1 | absent |
| `breakpoint-hit` | `c964b09f7660f2d71e1a6bfec537b0b107045c017c3b7255d04de412ecfbe0f2` | 19,915 | `e1096a6a18db10c06c1c99d895e898214dd6f2f4cd5b10be0454d636422d9c29` | 1 | absent |
| `implicit-control` | `52703d80ab6e6fd827f9aa267c1c81b5c15818c1325daae7249b7df033fcc9cc` | 19,838 | `e1096a6a18db10c06c1c99d895e898214dd6f2f4cd5b10be0454d636422d9c29` | 0 | absent |

All three variants also produced the same cache-key SHA-256:

```text
23f7d44581bfb8f22b964573d7bfcba205874f32f7308f8bf50621cebc66272a
```

The assertions require:

- one breakpoint in each breakpoint variant and zero in the control;
- no `prompt_cache_options` property in any payload;
- identical stable system text and cache key across all variants;
- distinct complete payloads, proving that the user suffixes were not accidentally reused;
- a stable prefix of at least 4,096 UTF-8 bytes.

The dry-run verdict was `proven`.

## Live Provider Evidence

Environment:

- date: 2026-08-10
- provider: `rayin-gpt`
- model: `gpt-5.6-terra`
- transport: OpenAI Responses
- configured request limit: 3
- attempted requests: 1
- completed measurements: 0
- verdict: `unsupported-or-incomplete`
- sanitized error: `OpenAI API error (502): 502 status code (no body)`

The failed payload was the same `breakpoint-warm` shape proven offline: one breakpoint, no `prompt_cache_options`, shared stable-prefix hash, and shared cache-key hash. Because it failed before a completed response, there are no valid `cacheRead`, input-token, or latency measurements to compare. The script did not fabricate zeros or continue to spend requests after the error.

## Decision

Keep both explicit prompt-cache capability flags disabled for this configured model. Continue using the existing implicit prompt cache key and the measured default context-pruning policy.

A future retest is justified only after the third-party provider explicitly documents breakpoint support or changes its gateway. A stronger availability-controlled retest would send an implicit request immediately before the breakpoint request, but it would spend additional model calls and is not needed for the current operational decision.

## Files

- Experiment runner: `test/sdk-openai-responses-breakpoint-only-ab.ts`
- Implementation plan: `docs/plans/2026-08-10-breakpoint-only-cache-proof.md`
- Related cache-prefix experiment: `docs/experiments/2026-08-10-context-cache-prefix-proof.md`

## Reference

- [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
