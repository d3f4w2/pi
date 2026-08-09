# Tool Execution Protection Architecture

## Problem

A tool is less trusted than the agent loop that owns it. It may hang, reject with an oversized or secret-bearing error, fail repeatedly with different arguments, or request a dangerous host action. None of those failures should terminate Pi or waste unbounded time and context.

Example:

```text
web_fetch starts reading a response
  -> the request is cancelled
  -> the response body rejects with RequestAbortedError
  -> without an ownership boundary, Pi exits
```

## Requirements

### Functional

- Bound every model-initiated tool execution with one configurable wall-clock timeout.
- Convert thrown values into short, redacted tool results.
- Treat caller cancellation separately from failure and never count it toward a circuit.
- Open a per-tool circuit after consecutive execution failures, even when arguments differ.
- Allow a probe after the cooldown and close the circuit after a success.
- Preserve the existing exact-call repeated-failure guard.

### Non-functional

- No model calls, network calls, subprocesses, or persistent background jobs in the protection layer.
- Constant bounded state per tool name and bounded error/fingerprint serialization.
- No added model tokens on successful calls.
- Existing tool event order and sequential/parallel result ordering remain valid.
- Late tool updates after timeout or cancellation are ignored.

## Architecture

```text
assistant tool call
        |
        v
exact-call guard
        |
        v
per-tool circuit
        |
        v
argument validation
        |
        v
deadline + abort boundary
        |
        +---- success ----------> close circuit for this tool
        |
        +---- caller abort -----> short cancelled result, do not count
        |
        +---- timeout/error ----> redact + cap error, increment circuit
```

## Components

### Agent core

`tool-failure-guard.ts` owns:

- error classification and redaction;
- the exact-call guard and per-tool circuit, including cooldown and half-open probing;
- bounded error text used by both the model and failure guards.

`agent-loop.ts` owns the timeout/abort race and remains the single execution owner. It applies the exact-call guard, circuit guard, validation hooks, execution boundary, post-hook, and result events in that order.

## Defaults

```json
{
  "toolFailureGuard": {
    "enabled": true,
    "repeatLimit": 2,
    "consecutiveLimit": 3,
    "cooldownMs": 30000,
    "timeoutMs": 180000
  }
}
```

The default keeps ordinary coding uninterrupted while bounding abnormal calls.

## Failure Modes

| Failure | Behavior |
|---|---|
| Tool ignores abort | The caller stops waiting at the boundary; late updates are ignored |
| Tool rejects after timeout | The already-observed promise rejection is contained |
| Error contains credentials | Common token, authorization, URL credential, and key-value forms are redacted |
| Three failures with different arguments | Circuit opens for that tool name |
| Circuit cooldown expires | One real execution is allowed as a probe |
| Probe succeeds | Circuit closes |
| Probe fails | Circuit opens again |

## Security

- No credential values are written to protection state or documentation.

## Verification

- Unit tests for timeout, caller abort, late completion, redaction, output caps, circuit opening, cooldown, probe success, and probe failure.
- Agent-loop tests for sequential and parallel event/result ordering.
- Coding-agent tests for settings defaults, clamping, SDK wiring, and diagnostic output.
- `/doctor` reports the effective timeout and circuit state without executing a tool.
- Repository-wide `npm run check`.
