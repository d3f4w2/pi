# Repeated Tool Failure Guard Architecture

## Requirements

### Functional

- Detect repeated tool calls with the same tool name, canonical arguments, and normalized error.
- Allow a configurable number of real executions before blocking another unchanged attempt.
- Return a normal error tool result that tells the model how to make progress.
- Give one recovery turn after the first block, then stop the run if the identical blocked call is repeated.
- Keep tool start/end and message events protocol-correct for blocked calls.
- Reset a fingerprint after success, changed error, changed arguments, or new user/steering/follow-up input.
- Keep the general agent-core behavior opt-in; enable it conservatively in coding-agent.
- Support sequential and parallel execution without changing result order.

### Non-functional

- No model call, network request, timer, file I/O, or persistent state.
- State is scoped to one active agent-loop run and is released at the end.
- Fingerprinting is deterministic and fail-open for non-JSON/circular arguments.
- Blocking must never execute the underlying tool or its side effects.
- The guard adds constant-time map access per call plus bounded argument/error serialization.

## Data flow

```text
assistant tool call
      |
      v
canonical fingerprint = tool name + sorted JSON arguments
      |
      v
failure state for fingerprint
  | below limit --------------------------> normal validation/hooks/execution
  | at limit + same last error -----------> synthetic error result, no execution
  | same blocked call repeated -----------> terminating error result, stop current run
      |
      v
final outcome
  | success ------------------------------> clear fingerprint
  | aborted / uninspectable --------------> do not count
  | error changed ------------------------> reset count to 1
  | same normalized error ----------------> increment count
```

When queued input containing a user message is injected, the map is cleared before the next provider request. A new `prompt()` or `continue()` already creates a new loop-scoped map.

## Components

### `RepeatedToolFailureGuard`

An internal agent-loop helper owns:

- stable JSON canonicalization with sorted object keys;
- bounded normalized error signatures;
- failure counters keyed by tool and arguments;
- block-message construction;
- reset behavior.

### Agent API

`AgentOptions.repeatedToolFailureLimit` and `AgentLoopConfig.repeatedToolFailureLimit` use these semantics:

- `0` or omitted: disabled;
- `N >= 1`: after `N` identical real failures, block the next unchanged call.

Agent core defaults to disabled for library compatibility. Coding-agent resolves its own settings and passes `2` by default.

### Coding-agent settings

```json
{
  "toolFailureGuard": {
    "enabled": true,
    "repeatLimit": 2
  }
}
```

## Error result

```text
Repeated tool call blocked: this exact read call already failed 2 times with the same error.
Do not repeat it unchanged. Change the arguments, use another tool, or explain the blocker.
Last error: ENOENT: file not found
```

The blocked result remains paired with its assistant tool call and is emitted through the normal `tool_execution_end`, `message_start`, and `message_end` events.

The first blocked result does not terminate, so the model can change arguments or choose another tool. If the next attempt repeats the same blocked call, that result sets the existing `terminate` hint. A batch stops only when every finalized result requests termination, preserving mixed-call behavior.

## Parallel execution

Failures from a completed parallel batch are recorded in assistant source order. Calls already launched in the same batch are not cancelled based on sibling outcomes because they began concurrently. The guard applies on the next assistant tool-call turn.

## Failure modes

| Failure | Behavior |
|---|---|
| Circular or unsupported arguments | Do not fingerprint; execute normally |
| Empty/non-text error result | Do not count it |
| Abort/cancel result | Do not count it |
| Changed error text | Start a new count at one |
| Any successful tool call | Clear all failure state because the environment may have changed |
| Guard implementation error | Execute normally |
| New user/steering/follow-up message | Clear all counters |

## Security

- A blocked call cannot repeat filesystem, process, or network side effects because its tool is not executed.
- Successful calls are never blocked and clear previous failures.
- Error text in the recovery notice is normalized and capped, preventing unbounded prompt growth.
- No error or argument data is persisted outside the existing session messages.

## Verification

- Unit tests for identical failures, changed arguments, changed errors, success reset, disabled mode, new-prompt reset, and canonical key order.
- Event assertions proving blocked calls retain valid tool result ordering.
- Termination assertion proving an ignored recovery instruction cannot create an infinite provider loop.
- Sequential and parallel tool-loop regression tests.
- Coding-agent settings and SDK wiring tests.
- Repository-wide type and formatting checks.

### Representative benchmark

On the development machine, 50,000 fingerprint checks plus failure-record updates over nested arguments completed in about 153 ms, or roughly 3.1 microseconds per call. This illustrates the overhead scale and is not a cross-machine performance guarantee.
