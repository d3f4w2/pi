# Tool Failure Guard

The guard prevents an agent from executing the exact same failing tool call indefinitely.

With a repeat limit of two:

1. the first call executes and fails;
2. the second unchanged call executes and returns the same error;
3. the third unchanged call is not executed and receives a recovery instruction.
4. if the model ignores that instruction and repeats the blocked call, the current run stops without another automatic provider turn.

Changing arguments or receiving a different error starts a separate failure path. Any successful tool call, or new user input, clears the accumulated state because the environment may have changed.

Agent-core consumers opt in with:

```ts
const agent = new Agent({
  streamFn,
  repeatedToolFailureLimit: 2,
  toolConsecutiveFailureLimit: 3,
  toolFailureCooldownMs: 30_000,
  toolExecutionTimeoutMs: 180_000,
});
```

The tool-wide circuit opens after consecutive execution failures even when arguments differ. It blocks work until cooldown, permits one half-open probe, closes on success, and reopens on failure. User cancellation is not counted. Thrown errors are redacted and capped before entering model context.

The generic timeout sends a child `AbortSignal`, stops waiting, observes any late settlement, and ignores late updates. A tool that ignores the signal may keep running, so tools should release resources promptly when aborted.

Omit an option or set it to `0` to disable that part of the guard. Pi coding-agent enables conservative defaults through `toolFailureGuard` settings. The latest bounded state is available at `agent.state.toolFailureGuard`.

The guard does not call a model or start another process. A 50,000-operation synthetic benchmark took about 153 ms on the development machine, roughly 3.1 microseconds per fingerprint check and update.
