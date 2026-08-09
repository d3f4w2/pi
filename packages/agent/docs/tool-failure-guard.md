# Repeated Tool Failure Guard

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
});
```

Omit the option or set it to `0` to disable the guard. Pi coding-agent enables a limit of two by default and exposes it through `toolFailureGuard` settings.

The guard does not call a model or start another process. A 50,000-operation synthetic benchmark took about 153 ms on the development machine, roughly 3.1 microseconds per fingerprint check and update.
