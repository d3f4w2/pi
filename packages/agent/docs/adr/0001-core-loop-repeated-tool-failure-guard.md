# ADR-0001: Guard Repeated Tool Failures in the Core Agent Loop

## Status

Accepted

## Context

Models sometimes repeat an unchanged tool call after receiving the same deterministic failure. Each repetition spends provider tokens and may repeat expensive filesystem, process, or network work without creating new evidence. Individual tools have partial circuit breakers, but validation errors, extension tools, and future tools do not share a consistent policy.

The guard must not suppress legitimate successful repetition, transient recovery with changed outcomes, or a user explicitly trying again later.

## Decision

Add an opt-in, loop-scoped repeated-failure guard to agent-core:

- fingerprint canonical tool name and arguments;
- count only consecutive identical normalized errors for that fingerprint;
- clear state on success or new user input;
- block the next unchanged execution after the configured limit;
- emit a normal error result with concrete alternatives;
- allow one recovery turn, then terminate the current run if the model repeats the blocked call;
- leave agent-core disabled by default and enable coding-agent with a limit of two.

## Consequences

### Positive

- Deterministic no-progress loops stop before wasting another tool execution and provider round.
- Validation, built-in, custom, and extension tools receive one policy.
- No new dependency, service, model call, persistence format, or background state is required.
- Tool event and message protocols remain intact.
- Users can retry in a new prompt or by changing arguments.

### Negative

- A truly transient failure that returns byte-equivalent text twice requires changed input or a new user turn for another attempt.
- Canonical serialization adds small per-call CPU work.
- Parallel calls already started in one batch cannot benefit from sibling failures.

### Neutral

- The guard does not decide which fallback tool to use; it gives the model a bounded recovery instruction.
- Existing provider retry and tool-specific circuit breakers remain active.

## Alternatives Considered

### Prompt-only instruction

Rejected because models can ignore it and repeated failures still execute before the mistake is observable.

### Wrap each coding-agent tool

Rejected because it misses core validation errors and external tools, duplicates state, and cannot reliably reset at agent-loop boundaries.

### Stop the entire agent on the first blocked call

Rejected because the model may still make progress with different arguments or another tool. The selected staged policy allows one recovery turn and stops only if that instruction is ignored.

### Persist failures across sessions

Rejected because environment state can change and a later user request should get a clean attempt.

## References

- [Repeated Tool Failure Guard Architecture](../tool-failure-guard-architecture.md)
- [Agent Loop](../../src/agent-loop.ts)
