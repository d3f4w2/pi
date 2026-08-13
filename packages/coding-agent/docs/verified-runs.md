# Verifiable runs

`pigo run` turns a one-shot coding task into an evidence-bearing engineering run. It uses the same Agent, tools, provider configuration, policy, and cache as interactive Pigo, then checks the result outside the model and writes a machine-readable receipt.

## The product contract

A run has four explicit parts:

```text
task + allowed scope + verification + budget
                         ↓
                  existing Pigo Agent
                         ↓
        Git change evidence + independent checks
                         ↓
                 integrity-protected receipt
```

The Agent can choose how to solve the task. It cannot redefine what files it was allowed to change, which checks count, or how much budget the parent process grants.

## Quick start

Run a task and independently verify the smallest safe project scope:

```bash
pigo run "Fix the parser regression and add a focused test"
```

Gate that run without copying its receipt path:

```bash
pigo ci
```

For a long objective that should keep using the active interactive session, use the durable goal loop:

```text
/run --scope packages/parser/src --scope packages/parser/test --verify auto:packages/parser 修复解析器并补回归测试
```

`/run` repeats Agent execution and independent verification until completion or a defined stop condition. Its terminal
receipt uses the same schema and private project partition as shell `pigo run`, so the terminal acceptance action inside
`/run` or shell `pigo ci` can gate it without a second evidence format. See [Durable goal loop](goal-loop.md).

Limit writes and make the budgets explicit:

```bash
pigo run "Fix the parser regression" \
  --scope packages/parser/src \
  --scope packages/parser/test \
  --verify auto:packages/parser \
  --timeout 900 \
  --max-tokens 50000 \
  --max-tool-calls 100
```

Forward ordinary Pigo model options after `--`:

```bash
pigo run "Fix the parser regression" -- --model openai/gpt-5.6
```

For CI or repeatable local work, store the contract in JSON:

```json
{
  "version": 1,
  "task": "Fix the parser regression and add a focused test",
  "scope": ["packages/parser/src", "packages/parser/test"],
  "verification": [
    { "operation": "auto", "path": "packages/parser", "timeoutSeconds": 120 }
  ],
  "budget": {
    "timeoutSeconds": 900,
    "maxTokens": 50000,
    "maxToolCalls": 100
  }
}
```

Then run it without allowing the Agent to change the loaded contract:

```bash
pigo run --contract pigo.run.json --receipt artifacts/pigo-run.json --json
```

## Outcomes

| Outcome | Meaning | Exit code |
| --- | --- | ---: |
| `verified` | The run changed files, stayed in scope, and every independent check passed. | 0 |
| `completed` | The run completed without a net workspace change. | 0 |
| `unverified` | Files changed, but no deterministic check ran successfully. | 2 |
| `failed` | The Agent failed or an independent check failed or timed out. | 1 |
| `noncompliant` | The run exceeded a budget, changed Git HEAD, or left an out-of-scope change. | 3 |

An Agent response is never itself verification evidence. A run that edits code but cannot execute a check remains `unverified`, even if the response says the task is complete.

## Workspace evidence

The first version requires a Git working tree. Before execution, Pigo records the current HEAD, Git index identities, and content fingerprints for already-dirty files. After execution, it repeats the dirty-file snapshot and compares the two states.

This handles an important real-world case: the repository may already contain user changes. A file is attributed to the run only when its before and after fingerprints differ. Existing unrelated dirty files are preserved and do not automatically become run changes.

The receipt stores relative paths and content fingerprints, never file contents. A HEAD change is a compliance violation because commits, resets, and branch movement would otherwise make before/after attribution ambiguous.

Evidence covers tracked files and unignored untracked files. Git-ignored build products, dependency directories, caches, and secret files are outside this incremental evidence set; the receipt records this coverage explicitly as `git-tracked-and-unignored`.

## Scope is evidence, not a sandbox

`--scope` defines allowed final workspace changes. Pigo checks it after execution and marks any violation. This is useful for CI policy and accidental overreach, but it does not prevent a process from writing outside the scope while it runs.

Use Pigo's container or operating-system sandbox when execution-time isolation is required. The receipt deliberately labels its control as post-run scope detection so consumers do not confuse it with containment.

## Independent verification

Each verification item runs Pigo's deterministic `VerifyService` in a separate verifier process after the Agent exits or an
interactive goal-loop iteration settles. Supported operations are `auto`, `typecheck`, `test`, and `lint`.

The receipt keeps only bounded structured evidence: check ID, status, duration, and normalized command. Failure logs remain in Pigo's private agent directory; their contents are not embedded in the receipt.

`auto` selects the smallest safe checks the repository supports. CI contracts should use explicit operations when a precise gate is required.

## Receipt privacy and integrity

The receipt contains:

- the contract hash and a hash/byte count for the task;
- Git HEAD and before/after workspace state digests;
- changed relative paths with before/after fingerprints;
- tool counts, tool errors, Token usage, cost, duration, and termination reason;
- independent check statuses and durations;
- a hash/character count for the final assistant response;
- the final outcome and SHA-256 integrity record.

It does not contain the task text, assistant response, source code, tool arguments, tool output, credentials, or raw event stream.

The parent sends the task to the Agent child over stdin, so private task text is not exposed in the operating-system process argument list.

The default location is outside the repository under Pigo's agent data directory. Receipts are partitioned by a SHA-256
identifier derived from the normalized Git workspace root, so `pigo ci` can find the current project's latest run without
mixing receipts from other repositories. The raw workspace path is not stored in the receipt. `--receipt` selects a
deterministic exported or CI artifact path. Existing files are not overwritten.

The SHA-256 value detects accidental or later content changes; it is not a cryptographic signature. A future CI trust layer can sign or attest the same canonical receipt without changing run semantics.

## How Agent CI consumes receipts

`pigo run` answers: “What happened in this execution, and is the result independently supported?”

`pigo ci` answers: “Do these concrete receipts satisfy the repository's deterministic governance policy?” With no input, it
checks the latest private receipt for the current project. `pigo ci --all` checks the project's stored history; explicit files
or directories check exported artifacts. It verifies integrity, evaluates per-run and aggregate limits, and produces a stable
merge decision without rerunning a model.

Model-backed evals answer a separate statistical question: “Across controlled tasks and versions, did the Agent get better
or regress?”

The run receipt is deliberately the boundary between them. See [Agent CI gates](agent-ci.md) for policy and report details.
