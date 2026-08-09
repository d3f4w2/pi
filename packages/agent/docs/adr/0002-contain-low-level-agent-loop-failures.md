# ADR-0002: Contain Low-Level Agent Loop Failures at the Producer Boundary

## Status

Accepted

## Context

The stateful `Agent` catches failures from `runAgentLoop()`, but the low-level `agentLoop()` helpers start the same async work with a detached promise that only has a fulfillment handler. A provider, context transform, queue callback, or future tool integration that rejects outside a narrower boundary can therefore create an unhandled promise rejection and terminate the host process.

The web response-body abort incident demonstrated that local cleanup defenses are necessary but not sufficient. The owning asynchronous task also needs a final containment boundary.

## Decision

- Add a rejection handler to each low-level Agent stream producer.
- Convert producer failures into the existing assistant error lifecycle and close the stream.
- Preserve all completed messages observed before the failure.
- Share failure-message construction with the stateful `Agent`.
- Do not install process-global exception handlers.

## Consequences

### Positive

- Detached Agent tasks cannot create unhandled rejections.
- Low-level consumers receive a complete, protocol-valid terminal event sequence.
- Failure behavior is consistent between stateful and low-level APIs.
- Existing tool-specific error recovery remains intact.

### Negative

- Low-level producer failures become stream data rather than rejected producer promises.
- Consumers that ignored error events must inspect the final assistant message to distinguish failure.

### Neutral

- Direct `runAgentLoop()` callers still receive rejected promises and retain explicit control.
- Errors outside Agent-owned async tasks are unaffected.

## Alternatives Considered

### Fix only `web_fetch`

Rejected as incomplete. The known response-body issue is already guarded, but other providers, transforms, hooks, and future tools can still reject.

### Install `process.on("uncaughtException")` and `process.on("unhandledRejection")`

Rejected because process-global recovery cannot prove the application remains consistent and can hide unrelated programming defects.

### Extend the generic `EventStream` with rejected results

Rejected for this milestone because it changes semantics across every AI provider stream and can itself produce an unhandled rejected result promise when consumers only iterate events.

## References

- [Failure Containment Architecture](../agent-loop-failure-containment-architecture.md)
- [Agent loop implementation](../../src/agent-loop.ts)
