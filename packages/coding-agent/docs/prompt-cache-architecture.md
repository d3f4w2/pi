# Prompt Cache Architecture

## Problem

Pi already derives an OpenAI Responses `prompt_cache_key` from the project, model, system prompt, tools, and output shape. That improves routing when the complete leading prompt is unchanged. GPT-5.6 explicit caching needs a more precise boundary: dynamic extension state appended to the system prompt must remain after the cache breakpoint, or each state change rewrites the cacheable prefix.

For example, the task-ledger extension appends its current revision to the base system prompt. The instructions and tools remain identical, but the full system string and the current routing fingerprint change. A provider that places its implicit breakpoint at the latest user or tool message cannot recover the stable base from the routing key alone.

## Architecture

The model-visible prompt remains byte-for-byte unchanged. `AgentSession` classifies the existing base system prompt as the stable prefix only when the effective per-turn prompt starts with that exact base. Replacing or prepending extensions disable segmented caching for that request instead of guessing a boundary.

The OpenAI Responses payload optimizer receives the stable prefix as local metadata. It:

1. hashes the stable system prefix, tools, model, project scope, and output shape into a bounded routing key;
2. excludes the dynamic system suffix and conversation tail from that key;
3. splits the serialized system/developer content at the exact prefix boundary only when both explicit-mode and breakpoint capabilities are enabled;
4. leaves unsupported providers on implicit caching;
5. emits hashes, byte counts, capability status, key churn causes, and per-key request rate without logging prompt text, paths, session IDs, schemas, or credentials.

```text
base system prompt ───────────────┐
                                  ├─ exact-prefix check ─┐
dynamic extension suffix ─────────┘                      │
                                                         v
tools + output shape + model + project ───────> stable routing hash
                                                         │
               provider capability matrix ───────────────┤
                                                         v
                                      implicit request or explicit breakpoint
```

## Capability Policy

Official OpenAI GPT-5.6 Responses models advertise explicit cache mode and content breakpoints from generated model metadata. Custom and third-party models remain disabled unless their configured compatibility flags explicitly enable both fields. This prevents one provider's syntax from being sent to gateways that reject it.

The configured `rayin-gpt/gpt-5.6-terra` gateway previously returned HTTP 502 for a breakpoint request. It therefore stays on the implicit path until a bounded manual experiment proves support. Capability probes are never automatic and never retry paid requests.

## Diagnostics

Each optimized payload can report:

- redacted hashes for the route, stable system prefix, full system prompt, tool order, canonical tool set, and output shape;
- stable-prefix and dynamic-suffix byte counts;
- explicit-breakpoint status;
- whether only the dynamic suffix changed;
- whether key churn came from model, project, system prefix, tool schema, tool order, or output shape;
- requests per key in the trailing minute and whether the documented hot-key threshold was exceeded.

Tool order is observed but never automatically sorted because order can affect model behavior. Hot-key sharding is also diagnostic-only until measured traffic justifies the duplicate cache warm-up cost.

## Usage Normalization

Responses gateways do not all expose cache counters in the same location. The adapter normalizes the official `input_tokens_details` fields and recognized OpenAI-compatible aliases into Pi's existing `usage.cacheRead` and `usage.cacheWrite` buckets. It uses the first valid representation for each counter to avoid double counting.

Cache-expiry analysis is model-aware: explicit GPT-5.6 requests use the configured 30-minute lifetime while providers without a verified explicit capability retain the conservative five-minute diagnostic window.

## Failure Behavior

- Missing or malformed payload: return it unchanged.
- Stable prefix does not exactly match serialized system content: keep implicit behavior and report `prefix-mismatch`.
- Provider lacks either explicit capability: do not send breakpoint fields.
- Extension changes or removes `prompt_cache_key`: preserve extension ownership, but still remove the private developer-context sentinel and restore its provider role.
- Diagnostic callback throws: ignore the callback failure and continue the provider request.
- Key exceeds provider limits: use the existing bounded SHA-256 format.

## Verification

Offline tests prove byte-preserving segmentation, dynamic-suffix exclusion, exact capability gating, redacted diagnostics, change classification, usage normalization, and failure-open behavior. The live experiment uses at most three paid requests with different user suffixes and treats provider cache counters as primary evidence; latency is secondary.
