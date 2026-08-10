# Cache Runtime P0-P2 Proof

## Result

The P0-P2 cache runtime is implemented and verified at three different evidence levels:

1. **Real provider usage already stored in long tasks:** eight sessions, 69 successful calls, 1,880,309 prompt tokens, 1,410,688 cache-read tokens, and a 75.02% weighted cache-read rate.
2. **Production-path structural proofs:** append-only developer revisions preserve a 98,441-byte complete item prefix in the controlled changed-suffix trace; stateful Responses reduces a 100,703-byte full payload to a 2,197-byte delta; adaptive breakpoints never exceed four and obey the write-cost gate.
3. **Focused executable verification:** 95 tests passed across the coding-agent and AI provider packages, the segmented serializer dry run remained proven, scoped formatting passed, and the browser smoke check passed.

The 75.02% value is measured provider behavior from the user's configured third-party API before this implementation. The historical trace exposes at most 185,638 additional recoverable prefix tokens, which would raise the same trace to an 84.90% ceiling if every identified gap became a provider cache read. That ceiling is an upper bound, not a claimed post-change live hit rate.

## Implemented Changes

### P0: Append-only dynamic developer context

An exact `before_agent_start` suffix is no longer rewritten into the first system item on every turn. Pi keeps the stable base in the system prompt and persists only changed suffix revisions as hidden transcript messages. The OpenAI Responses payload restores those messages to the `developer` role and removes the private sentinel before network transmission.

Safety behavior:

- unchanged revisions are not duplicated;
- removed suffixes emit a developer revocation so an older revision cannot stay active;
- replaced, prepended, empty-base, non-Responses, and `supportsDeveloperRole: false` paths retain the existing full-system behavior;
- model-visible suffix bytes are not summarized;
- restored sessions recover the last active revision from persisted metadata.

The real `AgentSession` test sent three turns with suffix sequence `v1, v1, v2`. It persisted exactly two revisions and kept the effective system prompt equal to the stable cache base.

### P0: Cache flight recorder

Each SDK session now joins final request-shape evidence with assistant usage and exposes a privacy-safe report through `session.getPromptCacheReport()`.

The report contains:

- actual cache-read and cache-write tokens;
- actual whole-session and last-response cache-read rates;
- exact serialized input-prefix bytes;
- project/model/system/tool/output drift cause counts;
- breakpoint ROI decisions;
- estimated savings against uncached input pricing;
- stateful continuation successes and fallbacks;
- cache-aware compaction deferrals.

It does not contain paths, prompt text, tool descriptions, provider keys, endpoints, or credentials. Observer and accounting errors are ignored by the request path.

### P1: Adaptive multi-breakpoint controller

Explicitly compatible OpenAI Responses models can now receive:

- one breakpoint at the exact stable system boundary;
- up to three recent text-only user/developer boundaries;
- never more than four breakpoints in one request.

History boundaries below 1,024 estimated prefix tokens are suppressed. With known pricing, each history boundary also requires one expected cache read to save more than its write premium.

Verified cases:

| Case | Result |
| --- | ---: |
| Long positive-ROI prompt | 4 total breakpoints |
| High write premium | 1 system breakpoint only |
| Small prompt | history breakpoints suppressed |
| Third-party `rayin-gpt/gpt-5.6-terra` | implicit path unchanged |

The configured gateway remains implicit because its earlier explicit request returned HTTP 502. No compatibility flag was force-enabled in production.

### P2: Cache-aware compaction

Threshold compaction may be deferred for one newer provider response when all conditions are true:

- at least two provider responses have been measured;
- the last response cache-read rate is at least 50%;
- the last response is inside the conservative five-minute cache lifetime;
- the context is inside a bounded one-quarter-reserve grace band;
- at least two projected output budgets remain;
- no earlier warm-cache deferral is active.

The duplicate pre-prompt check for the same assistant response honors the original deferral. A newer response causes normal compaction. Manual compaction, overflow recovery, cold caches, stale caches, and hard output margins are never deferred.

### P2: Local conversion memo

Completed custom-message conversions are memoized by object identity, mode, content reference/value, type, and timestamp. Mutating a conversion-sensitive field invalidates the entry. Plain, omitted, and private-sentinel modes have separate cache entries.

The benchmark used one 512-block custom developer message, 10,000 repeated conversions, five rounds per measurement, and three independent process runs:

| Run | Uncached | Memoized | Speedup |
| --- | ---: | ---: | ---: |
| 1 | 66.89 ms | 0.84 ms | 79.86x |
| 2 | 68.93 ms | 0.95 ms | 72.84x |
| 3 | 72.28 ms | 0.78 ms | 92.34x |

Median speedup by run was 79.86x. This is a conversion hot-path microbenchmark, not an end-to-end agent latency claim. Short string messages save allocations but will show a much smaller wall-clock effect.

### P2: Official OpenAI stateful Responses

`createAgentSession()` opts official OpenAI Responses sessions into stateful continuation by default. Callers can set `openAIStatefulResponses: false` to keep stateless `store: false` requests.

Continuation requires all of the following:

- provider id exactly `openai`;
- base URL host exactly `api.openai.com`;
- an SDK session id;
- final payload `store: true` after extension transformation;
- exact equality between the previously covered input-plus-output items and the current input prefix;
- exact equality of the non-input request shape;
- a non-empty delta.

On a prefix or shape mismatch Pi sends the complete payload. A response-handle 400/404 retries once with the complete payload and records a fallback. An official storage/ZDR rejection retries with `store: false` and disables stateful storage for that session. Three continuation failures open a session-local circuit. State is bounded to 128 sessions.

The deterministic payload proof measured:

| Metric | Value |
| --- | ---: |
| Full request | 100,703 bytes |
| Stateful delta request | 2,197 bytes |
| Upload/serialization reduction | 97.82% |

OpenAI still bills prior input tokens when `previous_response_id` is used. The 97.82% result applies only to client upload/serialization for this fixture; it is not a token-cost reduction.

Third-party endpoints never enter this path, even if they expose an OpenAI-compatible Responses API.

## Historical Real-Session Replay

Command, run from `packages/coding-agent`:

```text
node test/cache-runtime-p0-p2-benchmark.ts --sessions "$env:USERPROFILE\.pi\agent\sessions\--C--Users-24719-Desktop-pi--"
```

The runner reads only local session JSONL, filters successful `rayin-gpt/gpt-5.6-terra` responses, outputs aggregates and SHA-256 scope identifiers, and sends no provider request.

Selection rules:

- workspace session directory only;
- successful assistant responses for the exact provider/model;
- at least five matching calls per session;
- prompt tokens equal `input + cacheRead + cacheWrite`;
- prefix-gap upper bound on call `n` equals `max(0, min(prompt[n-1], prompt[n]) - cacheRead[n])`.

Results:

| Metric | Value |
| --- | ---: |
| Long sessions | 8 |
| Successful calls | 69 |
| Prompt tokens | 1,880,309 |
| Provider-reported cache reads | 1,410,688 |
| Actual weighted cache-read rate | 75.02% |
| Prefix-gap upper bound | 185,638 tokens |
| Maximum recoverable rate | 84.90% |

The prefix-gap formula is intentionally optimistic: retries, routing, branch changes, provider granularity, and legitimate prompt mutations can make part of the gap unrecoverable. It is used to size the opportunity, not to claim savings.

## Dynamic-Prefix Structural Proof

The benchmark replays a controlled two-turn shape with a 64 KiB stable base, 32 KiB user item, changed dynamic suffix, and appended assistant/user tail.

| Layout | Complete reusable input-item prefix |
| --- | ---: |
| Rewrite suffix inside first developer item | 0 bytes |
| Append changed developer revision | 98,441 bytes |
| Recovered complete item prefix | 98,441 bytes |

The old layout still has equal bytes inside the changed first item, but it has no complete identical input item at the dynamic boundary. The new layout preserves the complete stable base, first user item, and previous developer revision. This proves the structural cause of the improvement without requiring provider cache behavior to be inferred.

## Existing Live Provider Evidence

No new paid request was sent in this phase.

The authorized experiment budget was three requests. Two had already been attempted:

1. implicit control succeeded with 3,840 cache reads out of 9,689 prompt tokens, or 39.63%;
2. explicit warm request returned HTTP 502;
3. one request remains unused.

One remaining request cannot form a warm/hit pair and therefore cannot prove a new cache-rate or latency delta. Spending it would create a number without a valid control. The earlier real long-session audit remains the correct provider evidence for the implicit third-party path.

## Commands and Verification

Baseline:

```text
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/prompt-cache-optimizer.test.ts test/cache-stats.test.ts
```

Result: 21/21 passed before implementation.

Final focused coding-agent verification:

```text
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/prompt-cache-optimizer.test.ts test/prompt-cache-runtime.test.ts test/dynamic-developer-context.test.ts test/cache-aware-compaction.test.ts test/messages.test.ts test/cache-stats.test.ts test/agent-session-auto-compaction-queue.test.ts
```

Result: 49/49 passed.

Final focused AI-provider verification:

```text
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/openai-responses-state.test.ts test/openai-responses-compat.test.ts test/openai-responses-message-id.test.ts
```

Result: 46/46 passed.

Segmented serializer:

```text
node test/sdk-openai-responses-segmented-cache-ab.ts --dry-run
```

Result: `verdict: proven`; control and explicit-hit canonical visible SHA-256 remained identical, both explicit variants retained the 22,338-byte stable breakpoint, and all keys stayed within 64 characters.

Other checks:

- scoped Biome check for all changed files: passed;
- pinned dependency check: passed;
- relative TypeScript import check: passed;
- shrinkwrap and install-lock checks: passed;
- repository TypeScript check: passed;
- browser smoke check: passed.

The repository-wide `npm run check` passed after the concurrent worktree changes settled. None of the sandbox, package, lock, memory, learning, evaluation, debugging, LSP, or shell-routing files are part of this change.

## Verdict

- **Implemented:** all planned P0-P2 mechanisms.
- **Execution compatibility:** preserved by exact-prefix gates, provider gates, mutation checks, hard compaction margins, and full stateless fallback.
- **Actual current third-party long-task cache rate:** 75.02% across the measured real trace.
- **Historical recoverable ceiling:** 84.90%; this is an upper bound, not a new live measurement.
- **Proven request-shape improvement:** 98,441 additional complete prefix bytes in the changed-suffix fixture.
- **Proven official Responses upload reduction:** 97.82% in the deterministic full-versus-delta fixture; billing is unchanged.
- **Proven local conversion improvement:** 79.86x median hot-path speedup for the 512-block fixture.
- **New paid calls:** zero; one remains because it cannot prove a paired result.

The next honest provider-level measurement is a new real long task executed after this code is active, compared with the same flight-recorder definitions. A single isolated request should not be used as evidence.
