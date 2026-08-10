# Context Hygiene Architecture

## Requirements

### Functional

- Reduce repeated tool-output tokens before every provider request.
- Keep the persisted session transcript unchanged and fully recoverable.
- Preserve tool-call/tool-result pairing required by provider protocols.
- Prefer pruning results superseded by a newer result for the same tool request.
- Invalidate an older file read after a later successful `edit` or `write` changes the same normalized path.
- When unique old output must be reduced, retain bounded head/tail evidence and a recovery instruction.
- Never prune errors, images, instruction resources, or the newest protected tool-output budget.
- Keep deep results byte-identical when changing them would rewrite more than the configured prompt-cache tail.
- Let exact duplicate results bypass the recency and aggregate-savings floors only inside that bounded tail.
- Run extension context transforms before the built-in hygiene pass.
- Allow the behavior and budgets to be configured from normal settings.

### Non-functional

- No model call, network request, file read, child process, or background task.
- Linear time in the number and size of messages, with no mutation of caller-owned messages.
- Return the original array by reference when no useful reduction is available.
- Require a minimum estimated saving before changing context, avoiding prompt-cache churn for small gains.
- Bound cache churn using the estimated suffix of all messages, not only tool output.
- Fail open: any unexpected error returns the extension-transformed context unchanged.
- Produce deterministic output for the same messages and settings.

## High-level flow

```text
persisted session messages
          |
          v
extension context transforms
          |
          v
index assistant tool calls by toolCallId
          |
          v
classify tool results
  | protected: error / image / instruction / recent budget / deep cache prefix
  | superseded: newer identical request exists
  | invalidated: later successful edit/write changed the read path
  | stale-large: old, unique, above minimum size
          |
          v
estimate total savings
  | below minimum ------------------------> unchanged context
  | enough
          v
replace selected result content only
  | superseded -> compact recovery notice
  | stale-large -> notice + head/tail preview
          |
          v
provider-only context view
```

The session manager and transcript never receive the transformed messages. A resume, tree navigation, export, or later compaction still has the original result.

## Components

### `context-hygiene.ts`

Pure context transformation and statistics:

- associates tool results with their assistant tool calls;
- creates a stable request key from tool name and canonicalized arguments;
- marks earlier successful duplicates as superseded;
- tracks successful file mutations and marks earlier same-path reads as invalidated;
- protects recent output by walking newest to oldest;
- computes the all-message token suffix for every candidate;
- protects candidates whose suffix exceeds the prompt-cache tail;
- lets exact superseded requests bypass recency and savings floors inside that tail;
- selects old large candidates only when projected savings clears the configured floor;
- clones only the messages that are actually changed.

### Settings

`contextPruning` is independent from `compaction`: a user may disable model-generated compaction while still removing redundant tool output from provider requests.

Defaults:

| Setting | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Enable provider-context hygiene |
| `cacheWarmSuffixTokens` | `0` | Largest all-message suffix a replacement may invalidate; `0` disables the experimental guard |
| `protectRecentTokens` | `40000` | Keep newest tool output verbatim |
| `minimumSavingsTokens` | `8000` | Do nothing below this projected saving |
| `minimumResultTokens` | `512` | Ignore small results |
| `previewCharacters` | `320` | Head and tail characters retained for unique old output |

## Protection rules

The pass never changes:

- `isError` tool results;
- results containing images;
- `skill` results;
- `read` results for `skill://`, `AGENTS.md`, or `SKILL.md`;
- results inside the newest protected output-token budget;
- results with more than `cacheWarmSuffixTokens` estimated tokens after them;
- any result below the minimum result size.

Confirmed stale reads are the exception to the recent, minimum-size, and cache-suffix rules: correctness takes priority once a later successful `edit` or `write` proves that the old source is obsolete. Their replacement contains no source preview. Failed mutations, different paths, terminal commands, and unknown tools fail open.

Exact duplicate requests are compared using recursively sorted object keys. A later exact request can supersede an earlier one inside the cache tail even when the pair is inside the recent-output budget or below the aggregate savings floor. A focused `read(offset, limit)` does not incorrectly replace a whole-file read.

## Failure modes

| Failure | Behavior |
|---|---|
| Unknown/custom message shape | Leave that message unchanged |
| Circular tool arguments | Treat the request as unique |
| Failed mutation or path mismatch | Keep the earlier read unchanged |
| File changed through an unknown tool | Keep the earlier read unchanged |
| Invalid numeric setting | Use a safe bounded default |
| Extension transform pipeline throws | Return the original messages unchanged |
| Hygiene pass throws | Return the extension-transformed messages unchanged |
| Savings below floor | Return the original array unchanged |
| Cache-tail setting is `0` | Use legacy pruning without a suffix guard |

## Security and privacy

- No content leaves the existing provider request path.
- Tool output is never evaluated.
- Sensitive errors and authentication failures remain visible because errors are protected.
- The placeholder does not expose new paths or data; its preview is a bounded subset of content already destined for the provider.
- Full output remains in the local session history, so recovery is possible without weakening persistence.

## Verification

- Unit tests for duplicate detection, stale-read invalidation, failed and unrelated mutations, fresh post-mutation reads, recent-budget protection, protected result types, head/tail previews, deterministic output, disabled mode, and minimum-saving behavior.
- SDK integration test proving the provider receives the reduced view while `session.messages` remains complete.
- Benchmark using a synthetic long tool loop, reporting estimated tokens before/after and transform latency.
- Existing session, extension-context, compaction, and dynamic-tool tests.
- Repository-wide `npm run check`.

### Representative benchmark

A synthetic 120-call read loop contained about 241,280 estimated tokens. With an 8,000-token cache guard, the pass changed 2 results, saved about 3,936 tokens, and bounded the deepest rewritten suffix to about 6,033 tokens. With the guard disabled, it changed 110 results and saved about 213,200 tokens, but the deepest rewritten suffix was about 239,270 tokens. Transform time was about 1.08 ms versus 0.64 ms on the development machine.

A separate three-request live experiment against `rayin-gpt/gpt-5.6-terra` reported 5,632 cache-read tokens for both the guarded and legacy variants. The guarded variant sent 16,030 uncached input tokens versus 13,103 for legacy pruning, so it showed no cache-read benefit and 2,927 additional uncached input tokens. The guard therefore remains disabled by default. See the [complete experiment record](experiments/2026-08-10-context-cache-prefix-proof.md).
