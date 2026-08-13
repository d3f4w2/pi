# ADR 0053: Resilient goal recovery and receipt finalization

## Status

Accepted

## Problem

A multi-hour goal can outlive one process and depends on two durable artifacts: the latest session checkpoint and the final
receipt. Three edge cases could make those artifacts lie about the run:

- a partially written, manually edited, or future-incompatible custom session entry passed the old shallow shape check and
  could replace the last valid checkpoint;
- a transient receipt write error changed an already `verified` goal to `failed`, so the retry no longer described the
  verified execution;
- pausing after `goal_report` but before independent verification resumed the same reported turn, where a second
  `goal_report` was illegal, while resuming after the last completed verification could exceed the frozen iteration budget.
- a verifier or receipt write that completed after session-branch navigation could apply its stale result to the newly
  selected branch, and rapid duplicate direct starts could create two baselines before either start became visible.

For example, a verified goal whose receipt destination was briefly locked by an antivirus process became `failed`. When the
file became writable, the generated receipt then recorded the wrong terminal outcome. This is evidence corruption rather
than an ordinary UI error.

## Decision

Validate every restored goal checkpoint structurally before it can become authoritative. Validation covers lifecycle status,
timestamps, bounded contracts and budgets, metrics, iteration history, verification evidence, optional fields, and the
current-iteration invariant. Recovery scans backward and uses the newest valid checkpoint; malformed newer entries are
ignored.

Keep execution outcome and receipt persistence as separate facts. A receipt write failure records a bounded `receiptError`
without changing `verified`, `budget_exhausted`, `stopped`, or `failed`. Opening `/run` retries automatically, and a visible
retry action remains available after a repeated failure. Starting another goal is withheld until the terminal receipt exists,
preventing silent loss of the previous run's evidence.

Use the terminal state timestamp, not retry time, as receipt `finishedAt`. Receipt creation is therefore deterministic across
retries. The low-level writer treats an existing byte-identical receipt as a successful replay but still rejects different
content and never overwrites it. This closes the crash window where the file exists but its path checkpoint was not appended.

Record interactive terminal causes without collapsing them into Agent failure. Iteration-ceiling exhaustion uses
`iteration_budget`, and an explicit user stop uses `user_stopped`. Both remain rejected by the default CI policy;
`iteration_budget` derives `noncompliant`, while `user_stopped` derives `failed`.

Make resume phase-aware. A paused iteration that already has `goal_report` but no verifier result resumes directly at
independent verification. A paused iteration with completed verifier evidence starts a new Agent iteration only when the
frozen iteration budget permits it; otherwise it terminates as `budget_exhausted`.

Fence asynchronous starts, verifier results, and receipt writes. Goal starts are serialized and abort if the session branch
tip changes while the baseline is being captured. Verification and receipt completion may mutate state only when the active
run ID and state revision still match the captured checkpoint. Concurrent receipt attempts for the same run share one
in-flight write.

Keep the ten-tool periodic checkpoint interval for low session-log overhead, but flush any partial tail synchronously during
a clean `session_shutdown`. An abrupt process loss can still undercount at most nine tool results; a normal exit loses none.

## Consequences

### Positive

- Abrupt or corrupt session writes fail closed to the last valid checkpoint instead of creating an invalid control state.
- Transient filesystem failures cannot rewrite a verified engineering outcome.
- Receipt creation is explicitly recoverable through the sole `/run` control surface.
- A crash after the atomic file create but before session checkpointing can recover idempotently without overwriting evidence.
- CI can distinguish exhausted orchestration policy and an explicit stop from an Agent runtime failure.
- Resume never duplicates a structured report or silently grants an extra iteration.
- Slow stale work cannot overwrite another session branch, and a clean shutdown preserves the final partial tool metrics.

### Negative

- Strict validation may skip a hand-edited or newer-schema checkpoint instead of attempting a best-effort repair.
- A persistent receipt storage failure prevents starting the next goal until storage is repaired and receipt generation
  succeeds.

### Neutral

- The receipt schema is unchanged. `receiptError` is private session state and is not acceptance evidence.
- Process restart still requires explicit resume; this decision does not introduce detached execution authority.

## Alternatives considered

**Convert receipt errors into execution failure**

Rejected because storage availability does not change whether the frozen verifier passed.

**Accept the newest checkpoint with defaults for missing fields**

Rejected because invented budgets or lifecycle fields can silently broaden authority after restart.

**Restart every paused turn from a new Agent iteration**

Rejected because a turn may already have a valid structured report awaiting only model-external verification.
