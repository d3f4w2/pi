# Context Hygiene Architecture

## Requirements

### Functional

- Reduce repeated tool-output tokens before every provider request.
- Keep the persisted session transcript unchanged and fully recoverable.
- Preserve tool-call/tool-result pairing required by provider protocols.
- Prefer pruning results superseded by a newer result for the same tool request.
- When unique old output must be reduced, retain bounded head/tail evidence and a recovery instruction.
- Never prune errors, images, instruction resources, or the newest protected tool-output budget.
- Run extension context transforms before the built-in hygiene pass.
- Allow the behavior and budgets to be configured from normal settings.

### Non-functional

- No model call, network request, file read, child process, or background task.
- Linear time in the number and size of messages, with no mutation of caller-owned messages.
- Return the original array by reference when no useful reduction is available.
- Require a minimum estimated saving before changing context, avoiding prompt-cache churn for small gains.
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
  | protected: error / image / instruction / recent budget
  | superseded: newer identical request exists
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
- protects recent output by walking newest to oldest;
- selects old large candidates only when projected savings clears the configured floor;
- clones only the messages that are actually changed.

### Settings

`contextPruning` is independent from `compaction`: a user may disable model-generated compaction while still removing redundant tool output from provider requests.

Defaults:

| Setting | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Enable provider-context hygiene |
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
- any result below the minimum result size.

Exact duplicate requests are compared using recursively sorted object keys. A later exact request can supersede an earlier one, while a focused `read(offset, limit)` does not incorrectly replace a whole-file read.

## Failure modes

| Failure | Behavior |
|---|---|
| Unknown/custom message shape | Leave that message unchanged |
| Circular tool arguments | Treat the request as unique |
| Invalid numeric setting | Use a safe bounded default |
| Extension transform pipeline throws | Return the original messages unchanged |
| Hygiene pass throws | Return the extension-transformed messages unchanged |
| Savings below floor | Return the original array unchanged |

## Security and privacy

- No content leaves the existing provider request path.
- Tool output is never evaluated.
- Sensitive errors and authentication failures remain visible because errors are protected.
- The placeholder does not expose new paths or data; its preview is a bounded subset of content already destined for the provider.
- Full output remains in the local session history, so recovery is possible without weakening persistence.

## Verification

- Unit tests for duplicate detection, recent-budget protection, protected result types, head/tail previews, deterministic output, disabled mode, and minimum-saving behavior.
- SDK integration test proving the provider receives the reduced view while `session.messages` remains complete.
- Benchmark using a synthetic long tool loop, reporting estimated tokens before/after and transform latency.
- Existing session, extension-context, compaction, and dynamic-tool tests.
- Repository-wide `npm run check`.

### Representative benchmark

A synthetic 120-call read loop (240 messages, 30 repeatedly read paths, about 331,300 estimated tokens) transformed in about 0.87 ms on the development machine. The provider view fell to about 45,810 estimated tokens: an 86.2% reduction, while the source message array stayed unchanged. This is a scale illustration, not a cross-machine latency guarantee.
