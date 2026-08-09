# Agent Loop Failure Containment Architecture

## Requirements

### Functional

- A rejected low-level `agentLoop()` or `agentLoopContinue()` producer task must not become an unhandled promise rejection.
- The stream must finish with a standard assistant failure message and `agent_end` event.
- Messages already emitted before the failure must remain in the final stream result.
- Abort failures must use `stopReason: "aborted"`; other failures use `stopReason: "error"`.
- Tool execution, validation, and hooks keep their existing narrower error handling.
- The stateful `Agent` API and the low-level stream API must produce the same failure message shape.

### Non-functional

- No process-global exception handlers.
- No retry, network request, timer, dependency, or persistent state.
- Failure recovery must be bounded and synchronous after the producer promise rejects.
- A recovery-path failure must still close the event stream.
- Existing successful event order and public function signatures remain unchanged.

## Architecture

```text
tool / hook / provider / context transform
                 |
                 v
          runAgentLoop task
            |          |
         success     rejection
            |          |
            v          v
       normal events  shared failure message
            |          |
            |     message_start / message_end
            |     turn_end / agent_end
            |          |
            +----------+
                 |
                 v
          EventStream always ends
```

## Components

### Shared failure factory

`createAgentFailureMessage()` builds one protocol-correct assistant message from the active model, error, and abort state. The stateful `Agent` and low-level streams use the same factory so error behavior cannot drift.

### Observed message collector

The low-level wrapper records only `message_end` events. On failure it appends the synthetic assistant failure and publishes the complete observed message list through `agent_end`. Partial streaming messages are not persisted as completed messages.

### Producer boundary

`agentLoop()` and `agentLoopContinue()` attach both fulfillment and rejection handlers to their detached producer promise. The rejection handler emits the standard failure lifecycle directly to the returned `EventStream`, then closes it in `finally`.

The stateful `Agent` continues calling `runAgentLoop()` directly. Its existing lifecycle boundary catches the same rejection and uses the shared failure factory.

## Failure modes

| Failure | Result |
|---|---|
| Tool `execute()` throws | Existing error tool result; loop continues |
| Tool hook throws | Existing error tool result |
| Provider or context transform rejects | Assistant error message; run ends |
| Abort signal causes rejection | Assistant aborted message; run ends |
| Low-level stream has no active consumer yet | Failure events are queued; no unhandled producer rejection |
| Recovery event publication throws unexpectedly | Stream is closed in `finally` |
| Process bug outside an Agent-owned task | Not swallowed; normal process diagnostics remain |

## Security and reliability

- Error messages contain only the existing normalized `Error.message`, not stack traces or credentials.
- No global handler can accidentally hide memory corruption, programmer errors, or unrelated process failures.
- The boundary prevents extension/provider failures from escaping as detached rejected promises.

## Verification

- Synchronous provider initialization throw through `agentLoop()`.
- Context-transform rejection through `agentLoopContinue()`.
- Abort classification.
- Preservation of completed messages before failure.
- Existing Agent, tool execution, failure guard, and event-order regressions.
- Repository-wide formatting and type checks.
