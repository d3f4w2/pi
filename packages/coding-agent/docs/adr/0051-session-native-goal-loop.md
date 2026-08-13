# ADR 0051: Session-native durable goal loop

## Status

Superseded by [ADR 0052](0052-single-entry-run-control-center.md) for the interactive control surface. The lifecycle, verifier, checkpoint, and receipt decisions remain active.

## Problem

`pigo run` can execute one bounded Agent run and independently verify its final workspace, while `pigo ci` can evaluate the resulting receipt offline. Interactive Pigo still lacks a durable command that keeps the original goal stable across multiple turns, measures the remaining engineering gap outside the model, and continues only while progress and budget remain.

A prompt such as “keep trying until done” is insufficient. It does not define legal lifecycle states, survive interruption, distinguish an approval from a real product decision, enforce aggregate budgets, detect repeated non-progress, or give CI a stable artifact. Starting another interactive Pigo inside the current TUI would duplicate session ownership, approvals, context, rendering, and cancellation.

## Decision

Add one built-in goal-loop extension with a durable interactive execution and acceptance surface. The original revision used
`/run` and `/ci`; [ADR 0052](0052-single-entry-run-control-center.md) replaced both interactive surfaces with the sole `/run`
control center while retaining shell `pigo ci` for automation.

`/run` owns a versioned branch-local state machine. The initial goal, Git workspace root, verification contract, and aggregate budgets are immutable after start. An iteration can add only bounded execution metrics, an Agent report, independent verification evidence, a normalized gap fingerprint, and the next replanning instruction.

The lifecycle is:

```text
running -> verifying -> running
   |           |          |
   |           |          +-> waiting_user
   |           +------------> verified
   +------------------------> paused | budget_exhausted | stuck | stopped | failed
```

The existing AgentSession remains the only model and tool runtime. Existing trust, approval, sandbox, tool-failure, context, and session behavior therefore applies unchanged. A small structured `goal_report` tool lets the executing Agent declare `complete`, `continue`, or `needs_user`; this report is an orchestration signal, never proof of completion.

After every settled Agent iteration, the coordinator starts the existing verifier worker in a separate child process. The verifier receives only the frozen verification contract and workspace. A `complete` report becomes `verified` only when all configured deterministic checks pass and the Git HEAD and declared scope remain compliant. Failed or unavailable checks become the next iteration's concrete gap.

State checkpoints are appended to the current session branch. The initial Git snapshot is stored in a private run directory outside the repository because its full index can be too large for the conversation log. On normal completion, the coordinator compares the current workspace with that baseline and writes the existing privacy-safe version-1 receipt into the current project's private receipt partition. `/ci` invokes the existing offline receipt gate; it does not start a model or introduce a second policy implementation.

An interrupted `running` or `verifying` checkpoint restores as `paused`, never as an automatically executing job. `/run resume` is explicit. This prevents an old session from silently regaining tool authority after process restart or branch navigation.

Aggregate limits cover wall time, Agent iterations, Token usage, and tool calls. The coordinator may abort the current turn when a hard tool or wall-time limit is observed. Two consecutive identical normalized verification gaps without a changed workspace fingerprint stop as `stuck`. A `needs_user` report stops as `waiting_user` and records one concrete question; it must not be converted into repeated model calls.

## Consequences

### Positive

- Long tasks use the same session, permissions, tools, cache, and context rather than a competing runtime.
- The immutable goal and mutable plan are separated, so replanning cannot quietly redefine success.
- Verification is performed outside the executing model and feeds exact failures back into the next turn.
- Pause, explicit resume, budget exhaustion, repeated non-progress, and user decisions have distinct observable states.
- Terminal runs produce receipts accepted by the existing deterministic CI gate.

### Negative

- The loop can prove only configured deterministic checks; semantic requirements without executable acceptance criteria still rely on the Agent report and user review.
- An active TUI process must remain alive for uninterrupted execution. Process restarts require explicit resume.
- Repeated whole-project verification may be expensive; bounded verification contracts and iteration budgets are required.
- The baseline checkpoint contains workspace file identities and must remain in the private agent data directory.

### Neutral

- `/run` is a TUI command while `pigo run` remains the shell command. Both use the same receipt and verifier contracts, but one is session-native and the other is a standalone single execution.
- Waiting for tool approval is handled by the existing session UI. `waiting_user` is reserved for a decision that changes intended product behavior or scope.

## Alternatives considered

**Prompt-only “continue until done”**

Rejected. It has no durable state, independent verdict, aggregate budget, or deterministic stuck boundary.

**Launch a nested interactive Pigo for each iteration**

Rejected. It duplicates session and approval ownership, loses the active conversation context, and makes cancellation and UI behavior ambiguous.

**Build a separate workflow daemon first**

Rejected for the current stage. A daemon improves detached execution but duplicates lifecycle infrastructure before the local session loop has validated the product contract. The versioned state and private checkpoints leave a future daemon boundary available.

**Retry forever while verification fails**

Rejected. Repeated identical evidence is not progress. Explicit budget exhaustion and a decision-gated `stuck` state are required for cost, safety, and diagnosability.
