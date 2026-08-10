# ADR-0041: Use append-only branches for checkpoint and rewind

## Status

Accepted

## Context

Exploration is valuable local history but expensive recurring model input. Existing compaction is threshold-driven and model-generated. Provider context hygiene is transient and tool-output-specific. Session tree navigation can abandon a branch, but it does not guarantee an evidence-complete report, preview token savings, conflict detection, or a direct full-context restore. Turn undo restores files rather than model context.

The session JSONL is the audit and recovery record. Tool calls, failures, approvals, user requirements, and untrusted-source markings must remain inspectable. A rewind must not modify Git, restore files, or silently write conclusions into memory or self-evolution.

## Decision

Represent checkpoint and rewind as versioned extension entries on the existing append-only session tree.

- A checkpoint is a small custom entry containing a boundary reference, digests, token estimate, Git branch, and bounded workspace/content summaries. It does not copy message bodies.
- A rewind preview deterministically summarizes the branch after the checkpoint and measures messages, tokens, evidence retention, user-message retention, report latency, and prompt-cache prefix reuse.
- Interactive approval choices are first persisted as non-visible append-only decision entries, allowing rewind to retain both approvals and refusals rather than relying on transient UI state.
- Rewind apply requires explicit command confirmation and a compare-and-swap guard over session, persistent file, workspace, model, tool, and safety state.
- Apply navigates to the checkpoint, appends one model-visible report, and appends a non-visible active-view marker containing the original leaf reference.
- Restore navigates to the original leaf and appends a non-visible marker with restore duration so resume selects the restored branch and the timing remains auditable.
- The complete exploration branch remains unchanged and available through the session tree.
- The model-callable tool may create checkpoints and inspect previews but cannot apply rewind, restore, or deletion.

## Consequences

### Positive

- Full local history and recovery remain available without a second copy of checkpoint message bodies.
- The exact checkpoint prefix is retained, maximizing reusable prompt-cache prefix length.
- Rewind and restore use existing session tree, fork, clone, resume, and compaction behavior.
- Deterministic evidence and user-message retention can be tested at 100% without trusting a summarizing model.
- Unused tasks make no additional model calls; the discoverable tool is removed from active provider tools until requested.
- Failed and concurrent applies leave append-only audit evidence and restore the prior active leaf.

### Negative

- Post-checkpoint user requirements are repeated verbatim inside the report, adding bounded storage and report tokens.
- A large number of distinct tool calls produces a correspondingly large evidence manifest, because evidence is not sampled.
- JSONL conflict detection is optimistic. A concurrent writer can append between checks; the post-apply mirror check then rolls the active view back rather than pretending the transaction succeeded.
- Restoring a prior branch does not merge messages created later on the rewound branch; those messages remain available through tree navigation.

### Neutral

- Existing session JSONL format and version remain unchanged.
- Existing compaction summaries on the original branch are not reused when rewinding to a checkpoint before them.
- Rewind does not restore workspace files; `/undo-turn` remains a separate explicit workflow.
- Provider context hygiene can still prune new post-rewind tool output in transient requests.

## Alternatives considered

### Rewrite or truncate session JSONL

Rejected because it destroys the audit/recovery record, creates a large transaction problem, and violates append-only session behavior.

### Treat rewind as manual compaction

Rejected because compaction is model-dependent, does not preview exact evidence retention, cannot restore the original active branch directly, and rewrites the active prefix around a compaction summary.

### Store a mutable sidecar active-message bitmap

Rejected because fork, clone, resume, and tree navigation would need a second source of truth and atomic coordination with JSONL. An append-only marker makes the selected branch recoverable using existing semantics.

### Copy all retained messages into a new session

Rejected because it duplicates large message bodies, loses the original session-tree relationship, and prevents exact checkpoint-prefix cache reuse.

### Use a model to generate the rewind report

Rejected as the correctness path because generation can fail, omit deterministic evidence, follow untrusted content, and spend extra tokens. A future optional prose refinement may run only after the deterministic report exists and must never replace its evidence manifest.

## Failure modes

- Preview/report failure: do not navigate or append.
- Rejected confirmation: do not navigate or append.
- Guard mismatch: report conflict and do not navigate.
- Partial apply: navigate back to the original leaf and append a rollback marker.
- Concurrent persistent append: fail post-apply mirror validation, restore the original leaf, and leave the attempted branch for audit.
- Missing confirmation UI or protocol approval: fail closed.
- Restore failure: return to the pre-restore leaf and record rollback when possible.

## References

- [Context lifecycle architecture](../context-lifecycle.md)
- [ADR-0002: Provider-only context hygiene](0002-provider-only-context-hygiene.md)
- [ADR-0007: Turn workspace undo](0007-turn-workspace-undo.md)
- [ADR-0030: Cache-aware context pruning](0030-cache-aware-context-pruning.md)
- [ADR-0031: Shared-prefix prompt cache routing](0031-shared-prefix-prompt-cache-routing.md)
- [ADR-0032: Segmented explicit prompt cache](0032-segmented-explicit-prompt-cache.md)
