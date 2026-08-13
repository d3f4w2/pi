# ADR 0052: Single-entry goal control center

## Status

Accepted

Recovery and receipt-finalization behavior is extended by
[ADR 0053](0053-resilient-goal-recovery-and-receipts.md).

## Context

The first session-native goal loop exposed `/run <goal>`, `/run status`, `/run pause`, `/run resume`, `/run stop`, and `/ci`. The lifecycle was explicit, but the interface required users to remember verbs and allowed them to request actions that were illegal for the current state. More seriously, an interactive stop or pause could race an active Agent turn or child verification and persist a state or receipt before file mutation had certainly ended.

The product requirement is one interactive entry that remains fast for experts, guides ordinary users, supports multi-hour goals, and does not weaken the existing approval, scope, verification, budget, recovery, or receipt boundaries.

## Decision

Keep `/run <goal>` as the direct fast path and make bare `/run` a state-driven control center. Remove the registered interactive `/ci` command. Terminal receipt acceptance becomes an action inside `/run`; process automation continues to use shell `pigo ci`.

Put action derivation and execution presets in a pure control module. Keep state transitions in the existing state module and UI orchestration in the extension. Use ephemeral pause/stop requests plus Agent abort and settlement events so durable transitions occur only at safe mutation boundaries. A request received during child verification is applied after the bounded child returns and before replanning.

Offer bounded quick, standard, and eight-hour long-run presets. Every preset keeps deterministic verification, aggregate ceilings, stuck detection, explicit interruption recovery, and ordinary tool authority.

## Consequences

### Positive

- Users remember one entry and see only legal state actions.
- Direct `/run <goal>` remains fast and script-like.
- Stop and pause cannot finalize a receipt while the Agent is still editing.
- Long work has an explicit bounded preset rather than an informal “keep going” prompt.
- Interactive and shell CI share one evaluator without exposing two interactive entrances.

### Negative

- Remote clients must support extension selector/input requests to use the bare control center.
- The selector is less information-dense than a future full-screen run dashboard.
- A stop requested during verification waits for the current bounded verifier invocation to return.

### Neutral

- Existing textual `/run status|pause|resume|stop` forms become ordinary goal text; backward compatibility is intentionally not retained.
- Shell `pigo run` and `pigo ci` are unchanged.

## Alternatives considered

**Retain textual subcommands**

Rejected because it preserves the command-recall and illegal-transition problems.

**Build a permanent full-screen dashboard**

Deferred because it adds focus, keybinding, rendering, and cross-mode complexity without changing the state contract. The pure action model keeps this future option open.

**Stop immediately during active work**

Rejected because the Agent or verifier may still be mutating or observing the workspace, making the resulting receipt temporally invalid.
