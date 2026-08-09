# ADR-0002: Apply Deterministic Context Hygiene Only to Provider Requests

## Status

Accepted

## Context

Long coding sessions accumulate large `read`, `grep`, `bash`, LSP, and search results. Existing compaction waits until context approaches the model limit and then spends another model call to summarize history. This protects overflow recovery but repeatedly sends redundant output before the threshold and increases token cost, latency, and prompt noise.

The persisted session is also the recovery record. Destructively rewriting it would save space but make debugging, resume, export, and later reconstruction less trustworthy.

## Decision

Create a deterministic context-hygiene pass in the provider-request transformation pipeline:

- keep persisted messages unchanged;
- replace only selected tool-result content in the transient provider view;
- prune exact superseded requests first;
- protect errors, images, instructions, small outputs, and a recent output-token window;
- retain head/tail evidence for unique old results;
- require meaningful estimated savings;
- run after extension transforms and fail open.

## Consequences

### Positive

- Repeated provider calls send fewer tokens before full compaction is necessary.
- No extra LLM cost, network latency, dependency, process, or credential is introduced.
- The full transcript remains available for recovery and auditing.
- Provider tool-call/result ordering remains valid.
- Deterministic placeholders are stable enough for prompt-cache reuse.

### Negative

- A model may need to rerun a tool when exact old output becomes relevant.
- Character-based token estimation is approximate.
- Provider-visible context can differ from the transcript, requiring explicit integration tests.
- Canonical argument matching cannot prove semantic equivalence between different queries.

### Neutral

- Existing model-generated compaction remains the final context-window recovery mechanism.
- Users can disable context hygiene independently.

## Alternatives Considered

### Destructively rewrite session entries

Rejected because it weakens resume, export, debugging, and auditability. It also requires more complex storage transactions.

### Use an LLM to summarize tool outputs continuously

Rejected because it adds the same token cost, latency, failure modes, and nondeterminism the feature is meant to reduce.

### Drop every old tool result after a fixed number of turns

Rejected because age alone does not distinguish redundant output from unique evidence. The selected policy combines supersession, recent-token protection, minimum result size, and a minimum total saving.

### Wait for normal compaction

Rejected because redundant tool output is resent on every provider request before the threshold is reached.

## References

- [Context Hygiene Architecture](../context-hygiene-architecture.md)
- [Compaction](../compaction.md)
- [Oh My Pi compaction documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md)

