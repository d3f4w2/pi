# ADR-0003: Centralize Tool Execution Protection in Agent Core

## Status

Accepted

## Context

Exact repeated calls and detached agent-loop failures are already contained, but a tool can still fail repeatedly with different arguments, return oversized or sensitive errors, or ignore an expected completion time. Implementing protection separately in web, LSP, search, shell, and future extensions would produce inconsistent behavior and leave third-party tools unprotected.

The protection must preserve legitimate long-running work, user cancellation, parallel result ordering, and library compatibility.

## Decision

- Extend the existing core failure guard with a per-tool circuit breaker.
- Count execution failures and timeouts, but not validation blocks or user cancellation.
- Open after a configurable consecutive-failure limit and use a configurable cooldown with one half-open probe.
- Add an optional generic execution timeout backed by a child `AbortSignal`.
- Observe promises that outlive a timeout and discard their late updates.
- Normalize, redact, and cap every thrown tool error before it reaches model context.
- Publish a bounded snapshot through `AgentState` and coding-agent extension context.
- Keep all agent-core defaults disabled; enable conservative defaults in coding-agent settings.

## Consequences

### Positive

- Every built-in, extension, SDK, and future tool receives the same failure boundary.
- One unstable tool cannot repeatedly consume provider turns or crash the main workflow.
- Errors use fewer tokens and avoid common credential leakage.
- `/doctor` can explain why a tool is temporarily unavailable.
- No new dependency, service, persistence format, or process-global handler is introduced.

### Negative

- A transient service that fails three consecutive calls is unavailable until cooldown or the next user prompt.
- A tool that ignores `AbortSignal` may continue work after the loop has returned a timeout result.
- Agent state and coding-agent context gain a small diagnostic API surface.

### Neutral

- Tool-specific timeouts and retry policies remain valid and can be shorter than the generic cap.
- Circuit state is intentionally not persisted across sessions or new user prompts.

## Alternatives Considered

### Wrap each coding-agent tool

Rejected because it duplicates policy, misses SDK and third-party tools, and drifts as tools are added.

### Install global uncaught exception handlers

Rejected because global recovery cannot prove runtime consistency and can hide unrelated programming errors.

### Stop the agent on every tool failure

Rejected because most failures are recoverable through changed arguments or another tool.

### Persist circuits across sessions

Rejected because local files, credentials, services, and network state may change between user tasks.

## References

- [Tool Execution Protection Architecture](../tool-execution-protection-architecture.md)
- [Repeated Tool Failure Guard Architecture](../tool-failure-guard-architecture.md)
- [Agent Loop Failure Containment Architecture](../agent-loop-failure-containment-architecture.md)
