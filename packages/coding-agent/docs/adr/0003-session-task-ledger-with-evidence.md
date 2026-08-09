# ADR-0003: Use a Versioned Session Task Ledger with Completion Evidence

## Status

Accepted

## Context

Long coding tasks outlive one model turn and often outlive one context window. Prose plans in chat become stale, may be removed by compaction, and cannot safely distinguish two tasks with the same text. A model can also declare work complete without recording how it was verified.

Oh My Pi provides a useful phase-based todo tool, but its model-facing operations primarily target exact task content. This fork needs stronger consistency while keeping the feature local, fast, and optional through `/tools`.

## Decision

- Add a built-in `todo` extension tool backed by append-only session snapshots.
- Give phases and tasks monotonic stable IDs.
- Require optimistic `expected_revision` checks for every mutation.
- Require bounded evidence when completing a task.
- Enforce one active task and deterministic automatic progression.
- Restore from the current session branch, not process-global state.
- Append only a bounded open-work summary to the current run's system prompt, without persisting reminder messages.
- Show a compact TUI widget and expose `/tasks` for the full state.

## Consequences

### Positive

- Long tasks survive restart, compaction, and branch navigation.
- Stale or parallel writes cannot silently overwrite newer progress.
- Completion claims retain concrete verification evidence.
- Stable IDs remove ambiguity and reduce repeated long task strings in tool calls.
- Full snapshots stay outside provider context unless explicitly viewed.

### Negative

- The model must carry the latest revision number for mutations.
- Append-only snapshots add small session-file growth.
- Reconstructing state scans the current branch backward until a valid snapshot is found.

### Neutral

- The ledger coordinates work but does not execute tasks or tests itself.
- Simple one-step requests do not need the tool.
- Users can disable it through the existing persistent `/tools` manager.

## Alternatives Considered

### Store a Markdown checklist in the transcript

Rejected because updates require reparsing prose, consume context repeatedly, and are fragile after compaction.

### Target tasks by exact title

Rejected because duplicate or renamed tasks are ambiguous. Stable IDs are shorter and deterministic.

### Persist a mutable JSON file in the repository

Rejected because it pollutes user projects, creates merge conflicts, and does not follow session branches.

### Automatically continue until every task is closed

Rejected because forced extra model turns consume tokens and may continue past a real blocker. The ledger provides state and bounded reminders without autonomous retry loops.

## References

- [Todo Task Ledger Architecture](../task-ledger-architecture.md)
- [Oh My Pi todo documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/todo.md)
