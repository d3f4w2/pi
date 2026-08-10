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
