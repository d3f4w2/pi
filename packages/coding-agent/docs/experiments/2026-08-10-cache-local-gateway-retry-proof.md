# Cache-Local Gateway Retry Proof

## Result

P3 closes the observed transient-gateway gap without increasing the configured total retry budget:

- a deterministic OpenAI Responses test returns HTTP 502 once, then succeeds;
- both HTTP attempts carry the exact same serialized request body and headers;
- the retry is recorded as one recovery without retaining error text;
- HTTP 429 is not retried by the new default;
- an internally consumed attempt is deducted from AgentSession's outer retry budget;
- an explicit provider retry count is capped to the remaining outer budget;
- provider retries are disabled during an outer retry, preventing multiplicative loops;
- cache reporting now separates first-response and subsequent-response hit rates.

No paid provider request was sent for P3.

## Consolidated P0-P3 Metrics

### Current live provider observations

| Metric | Cold request | Immediate warm request | Change |
| --- | ---: | ---: | ---: |
| Prompt tokens | 13,136 | 13,194 | +58 |
| Provider cache-read tokens | 0 | 12,800 | +12,800 |
| Provider cache-read rate | 0% | 97.01% | +97.01 percentage points |
| Uncached prompt remainder | 13,136 | 394 | -97.00% |
| Wall time | 13.4 s | 6.0 s | -55.22% observed |
| Output throughput | 3.7 tok/s | 14.9 tok/s | 4.03x observed |
| Output tokens | 49 | 89 | +40 |

The cache-rate change is provider-reported and directly comparable. Wall time and throughput are observations from different model outputs, not a controlled latency benchmark; the table records them but does not attribute the complete speed difference to caching.

The warm request left only 394 of 13,194 prompt tokens uncached, or 2.99%. This is the strongest current post-routing provider measurement.

### Historical real-session baseline

| Metric | Value |
| --- | ---: |
| Pre-routing long sessions | 8 |
| Successful provider calls | 69 |
| Prompt tokens | 1,880,309 |
| Cache-read tokens | 1,410,688 |
| Mixed cold/warm weighted rate | 75.02% |
| First-call weighted rate | 13.69% |
| Subsequent-call weighted rate | 78.13% |
| Identified prefix-gap upper bound | 185,638 tokens |
| Historical maximum recoverable rate | 84.90% |

These sessions all predate shared-prefix routing. They are the comparison baseline, not the optimized result. The 84.90% value is an optimistic replay ceiling for the old trace and must not replace the live 97.01% warm measurement.

### Deterministic optimization proofs

| Optimization | Before | After | Measured effect |
| --- | ---: | ---: | ---: |
| Changed dynamic developer suffix | 0 complete reusable prefix bytes | 98,441 bytes | +98,441 bytes |
| Official stateful Responses upload | 100,703-byte full payload | 2,197-byte delta | -97.82% upload/serialization bytes |
| Repeated 512-block local conversion | 81.99 ms | 0.99 ms | 82.64x latest replay speedup |
| P0-P2 conversion benchmark | uncached | memoized | 79.86x three-run median speedup |
| Segmented stable boundary | implicit only | 22,338-byte explicit boundary | visible payload hash unchanged |
| Transient gateway retry | failure reaches outer lifecycle | one local retry | identical body and headers |

The stateful Responses result applies only to official OpenAI upload and serialization. OpenAI input billing remains unchanged. The configured third-party endpoint remains on the implicit, stateless path.

### Retry, reliability, and cost limits

| Metric | Optimized behavior |
| --- | --- |
| Default local gateway retries | 1 |
| Default retry statuses | statusless transport failure, HTTP 502, 503, 504 |
| Default HTTP 429 retries | 0 |
| Request mutation across retry | 0 body changes, 0 header changes |
| Retry diagnostic payload | attempt count plus `success` or `failed` only |
| Default AgentSession retry budget | 3 retries after the initial attempt |
| Maximum attempts under that budget | 4 total HTTP attempts |
| Nested retry multiplication | prevented |
| Explicit provider count above remaining budget | capped |
| Paid requests used by P3 proof | 0 |

The observed pre-P3 502 recovery took 9.18 seconds and returned on a cold route. P3 moves the first recovery attempt inside the original provider request lifecycle. It preserves all client-controlled cache inputs, but provider failover can still select a cold shard.

### Verification coverage

| Verification | Result |
| --- | ---: |
| AI provider tests | 56/56 passed |
| Coding Agent tests | 67/67 passed |
| Total focused tests | 123/123 passed |
| Repository Biome scope | 1,287 files, no fixes |
| Full `npm run check` | passed |
| Segmented serializer dry run | `verdict: proven` |
| Historical replay provider requests | 0 |
| P3 paid provider requests | 0 |

## Live Trace That Motivated P3

The trace came from the configured `rayin-gpt/gpt-5.6-terra` OpenAI-compatible Responses endpoint after shared-prefix routing was active:

| Step | Outcome | Prompt tokens | Cache-read tokens | Cache-read rate |
| --- | --- | ---: | ---: | ---: |
| First request | success | 13,136 | 0 | 0% |
| Immediate warm request | success | 13,194 | 12,800 | 97.01% |
| Next request | HTTP 502 before usage | 0 | 0 | not measurable |
| Existing outer recovery, 9.18 s later | success | 13,294 | 0 | 0% |

The second row is the relevant current warm-request measurement: `12,800 / (12,800 + 394) = 97.01%`. The later zero does not prove a client prefix change; an empty 502 followed by a cold recovery is also consistent with gateway failover or loss of provider cache-shard affinity. P3 preserves the exact client payload and retries earlier, but it cannot force a third-party gateway to retain or route its cache.

## Historical Cold/Warm Split

The local replay reads the same eight pre-routing long sessions used by the P0-P2 audit. It sends no provider request.

| Bucket | Calls | Prompt tokens | Cache-read tokens | Weighted rate |
| --- | ---: | ---: | ---: | ---: |
| First successful call per long session | 8 | 90,669 | 12,416 | 13.69% |
| Subsequent successful calls | 61 | 1,789,640 | 1,398,272 | 78.13% |
| Combined historical trace | 69 | 1,880,309 | 1,410,688 | 75.02% |

All eight sessions predate the shared-prefix routing implementation. Therefore 75.02% and 78.13% are historical baselines, not post-change claims. The only current post-change warm observation in this proof is 97.01%.

## Deterministic Same-Payload Experiment

The provider test intercepts the production `fetch` path. Attempt one returns an empty HTTP 502. Attempt two receives a valid Responses SSE completion. The test serializes both outgoing bodies and normalized header entries and requires strict string equality.

Assertions:

1. exactly two HTTP requests occur;
2. `body[1] === body[0]`;
3. `headers[1] === headers[0]`;
4. the assistant response completes normally;
5. diagnostics report one provider retry with `status: success`;
6. two failed HTTP 502 attempts report `status: failed` without retaining the response body;
7. a separate HTTP 429 case performs exactly one request.

This proves every cache-relevant value controlled by the serialized request is unchanged in the pinned SDK path. It does not claim that a gateway will route identical attempts to the same backend cache.

## Shared Retry-Budget Experiment

The AgentSession fixture uses a maximum of three retries. Its first failed Agent call reports that one provider-layer attempt was already consumed. Two later Agent calls fail and succeed respectively.

Observed accounting:

- initial HTTP attempt: 1;
- internal provider retry: 1;
- remaining outer retries: 2;
- total HTTP attempts: 4, equal to one initial attempt plus the configured three retries.

The SDK fixture also sets provider `maxRetries` to zero whenever `session.retryAttempt > 0`. This prevents each outer retry from starting another inner retry tree.

A second SDK fixture configures two outer retries and six provider retries. The effective provider count is two. The default SDK fixture also proves that an unset count remains `undefined`, allowing the Responses adapter to apply its narrower one-attempt 502/503/504 policy.

## Privacy and Correctness

- Retry diagnostics contain only integer attempt counts and `success` or `failed`.
- The cache runtime ignores the provider's error message.
- Failed responses with zero prompt usage do not occupy the first successful response bucket.
- The request is transformed once before the retry closure, so model-visible content and execution options are unchanged.
- Abort signals and explicit caller retry settings retain their existing behavior.

## Commands

AI provider verification, run from `packages/ai`:

```text
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/provider-retry.test.ts test/openai-responses-compat.test.ts test/openai-responses-state.test.ts test/openai-responses-message-id.test.ts
```

Result: 56/56 tests passed.

Coding Agent verification, run from `packages/coding-agent`:

```text
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-session-retry.test.ts test/sdk-stream-options.test.ts test/prompt-cache-runtime.test.ts test/prompt-cache-optimizer.test.ts test/dynamic-developer-context.test.ts test/cache-aware-compaction.test.ts test/messages.test.ts test/cache-stats.test.ts test/agent-session-auto-compaction-queue.test.ts
```

Result: 67/67 tests passed.

Historical replay, run from `packages/coding-agent`:

```text
node test/cache-runtime-p0-p2-benchmark.ts --sessions "$env:USERPROFILE\.pi\agent\sessions\--C--Users-24719-Desktop-pi--"
```

The output included `providerRequests: 0`.

Segmented serializer dry run, also from `packages/coding-agent`:

```text
node test/sdk-openai-responses-segmented-cache-ab.ts --dry-run
```

Result: `verdict: proven`; the implicit control and explicit-hit canonical visible SHA-256 values matched, the explicit variants retained the 22,338-byte stable boundary, and cache keys remained below 64 characters.

Repository verification:

```text
npm run check
```

Result: passed. Biome checked 1,287 files without fixes; pinned dependencies, relative TypeScript imports, shrinkwrap, coding-agent install lock, TypeScript, and browser smoke checks all passed.

## Verdict

- **Current measured warm request:** 97.01% cache read.
- **Historical pre-routing long-task aggregate:** 75.02% combined, 78.13% after first calls.
- **New transport behavior:** one byte-identical default retry for statusless transport failures and HTTP 502/503/504.
- **Retry cost ceiling:** unchanged because inner attempts consume the outer budget.
- **Provider-side guarantee:** none; identical client requests maximize cache eligibility but cannot control gateway shard routing.
- **New paid calls:** zero.
