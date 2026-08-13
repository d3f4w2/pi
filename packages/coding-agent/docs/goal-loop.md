# Durable goal loop

Interactive `/run` is Pigo's long-running engineering executor. It keeps one original objective stable while repeatedly
changing the plan in response to independent evidence.

```text
understand goal -> execute -> verify remaining gap -> replan
                -> execute -> verify -> ...
                -> verified | budget exhausted | stuck | waiting for user
```

This is different from asking the model to “keep trying.” Pigo owns the lifecycle, budgets, checkpoints, verification, and
terminal receipt. The Agent owns implementation decisions inside the existing trust, approval, workspace, and sandbox
boundaries.

## Start a goal

From interactive Pigo:

```text
/run 修复解析器回归并增加一个聚焦测试
```

Freeze explicit scope and checks for higher-value work:

```text
/run \
  --scope packages/parser/src \
  --scope packages/parser/test \
  --verify auto:packages/parser \
  --timeout 7200 \
  --max-tokens 400000 \
  --max-tool-calls 400 \
  --max-iterations 12 \
  修复解析器回归并增加一个聚焦测试
```

Options may appear before the goal. Use `--` if the goal itself begins with a dash:

```text
/run -- --replace-legacy-parser
```

For guided start, enter bare `/run`, choose **开始新目标**, describe the result, and select a bounded execution preset.

## What is frozen

At start, Pigo records:

- the original goal;
- the Git workspace root and initial Git/index/dirty-file evidence;
- allowed final change scopes;
- deterministic verification operations and paths;
- aggregate wall-time, Token, tool-call, and iteration budgets.

The goal loop cannot weaken those values during replanning. A new contract requires a new `/run`.

## One iteration

1. Pigo sends the immutable goal and latest verified gap into the active AgentSession.
2. The Agent uses the normal Pigo tools, approval UI, context, cache, and sandbox.
3. At the end, the Agent calls the structured `goal_report` tool with one state:
   - `complete`: it believes the semantic goal is satisfied;
   - `continue`: it has a concrete remaining gap it can still address;
   - `needs_user`: one product, scope, or irreversible decision is genuinely required.
4. After the Agent fully settles, Pigo starts the existing verifier worker in a separate child process.
5. Pigo records bounded check IDs, status, duration, normalized command, and the current workspace digest.
6. The state machine either verifies completion, creates a new iteration with the exact gap, waits for the user, or stops.

`goal_report` is an orchestration signal. It is never acceptance evidence by itself.

## Completion rule

A goal becomes `verified` only when both conditions hold:

1. the Agent reports `complete`;
2. every frozen deterministic verification item passes.

If files changed, the final receipt also records Git HEAD movement and scope violations. The default CI policy rejects a
changed HEAD, out-of-scope changes, failed or unavailable checks, tool errors, and non-verified outcomes.

Passing checks prove only the configured acceptance boundary. They cannot prove an underspecified semantic requirement or
replace human code review for high-risk work.

## One control entry

Enter `/run` without arguments. Pigo derives the legal actions from the current state instead of accepting memorized
subcommands:

| Current state | Actions shown by `/run` |
| --- | --- |
| No goal | Start a goal, help |
| `running` / `verifying` | Status, pause, stop |
| `paused` | Status, continue, stop |
| `waiting_user` / `stuck` | Status, provide one decision and continue, stop |
| Terminal state | Result, generate or retry receipt, independently accept it, then start a new goal |

Status shows elapsed and remaining wall time, Token/tool budget percentages, iteration count, latest independent evidence,
the current gap, and receipt path. Canceling the menu changes nothing.

Pause and stop are safe-boundary requests. During an Agent turn, Pigo first aborts and settles that turn before persisting the
transition. During child verification, the bounded check returns before Pigo applies the request, and no new Agent iteration
starts. A stop receipt is therefore never finalized while the same run can still mutate files.

Press Escape to abort an active Agent turn. Pigo records the goal as paused; enter `/run` and choose continue.

## States

| State | Meaning | Automatic continuation |
| --- | --- | --- |
| `running` | An Agent iteration is active or ready to start. | Yes |
| `verifying` | The model has stopped; the child verifier is running. | After verdict |
| `paused` | User abort, explicit pause, or interrupted process/session. | No |
| `waiting_user` | One concrete decision changes intended behavior or scope. | No |
| `verified` | Agent reported complete and every frozen check passed. | Terminal |
| `budget_exhausted` | Aggregate wall, Token, tool, or iteration limit was reached. | Terminal |
| `stuck` | The same normalized gap and workspace digest repeated twice. | No; requires a decision |
| `stopped` | User stopped the goal. | Terminal |
| `failed` | Agent, verifier coordination, or baseline handling failed. | Terminal |

Waiting for an existing tool approval is not `waiting_user`; the normal approval UI remains authoritative. The goal state is
reserved for a decision that changes what should be built.

## Checkpoint and recovery

Goal state is appended to the current session branch. The full initial Git snapshot is too large for ordinary conversation
entries, so Pigo stores it under its private agent data directory in `goal-runs/<run-id>/baseline.json`.

During a long Agent turn, aggregate tool-use state is checkpointed every ten tool results. This bounds budget undercount after
an abrupt process loss without adding one session entry per tool call. A clean session shutdown flushes the final partial
batch, so normal exit loses no tool metrics. Ordinary response usage is checkpointed at turn end; context-compaction usage is
charged and checkpointed as soon as compaction completes. Crossing the frozen Token ceiling at that boundary aborts
automatic retry and writes a terminal receipt.

If Pigo exits while a goal is `running` or `verifying`, the next load changes it to `paused`. It does not automatically resume
and regain tool authority. Continue explicitly:

```text
/run
→ 继续执行
```

Session-tree navigation restores the checkpoint belonging to the selected branch.

Restore validates the complete checkpoint structure, including status, timestamps, frozen contract, budgets, metrics,
iteration history, verification evidence, and current-iteration consistency. If the newest custom entry is malformed, Pigo
walks backward to the newest valid checkpoint instead of inventing missing authority or crashing recovery.

Long-running asynchronous work is revision-fenced. If the selected session branch changes while a verifier or receipt write
is in flight, its stale completion is discarded instead of being applied to the new branch. Rapid duplicate starts are
serialized, and a start whose branch changes during baseline capture is canceled before it gains execution authority.

Resume is phase-aware. If a paused Agent turn already submitted `goal_report`, Pigo continues at independent verification
instead of asking the same turn to report twice. If verifier evidence was already recorded, Pigo starts another Agent
iteration only while the frozen iteration budget still permits it.

## Receipts and CI

Every terminal goal attempts to write the same privacy-safe version-1 receipt used by shell `pigo run`. The receipt contains
hashes, relative paths, aggregate metrics, check evidence, termination reason, and outcome. It does not contain goal text,
assistant text, source code, tool arguments, or raw tool output.

Interactive receipts preserve exact orchestration causes: iteration-ceiling exhaustion is `iteration_budget`, and explicit
stop is `user_stopped`; neither is mislabeled as `agent_failed`. The default CI policy still rejects both.

If a later Agent iteration stops before its verifier runs, the receipt retains the most recent non-empty independent
verification evidence from the run. This does not turn the stop into success; it preserves diagnostics while the terminal
outcome remains failed.

A receipt storage error does not rewrite the execution outcome. Pigo keeps the original terminal state, records a bounded
private error, retries when `/run` opens, and exposes **重试生成回执** after repeated failure. A new goal is unavailable until
the terminal receipt exists, so completion evidence cannot be silently abandoned.

Receipt retries keep the original terminal timestamp. If the previous attempt already created the exact same integrity-bound
file but exited before checkpointing its path, the write is treated as an idempotent success. Existing different content is
never overwritten.

Use either interface:

```text
/run
→ 独立验收回执
```

```bash
pigo ci
```

See [Verifiable runs](verified-runs.md) for the receipt boundary and [Agent CI gates](agent-ci.md) for policy.

## Execution presets and limits

Bare `/run` guided start offers:

| Preset | Wall time | Tokens | Tool calls | Iterations | Intended work |
| --- | ---: | ---: | ---: | ---: | --- |
| Quick | 30 minutes | 200,000 | 200 | 8 | Focused fixes |
| Standard | 2 hours | 400,000 | 400 | 12 | Ordinary repository work |
| Long run | 8 hours | 1,000,000 | 1,000 | 32 | Migrations and broad refactors |

Passing acceptance always ends immediately; these values are ceilings, not requested consumption. Direct `/run <goal>` uses
the standard preset and accepts the following explicit limits:

| Budget | Default | Maximum accepted by `/run` |
| --- | ---: | ---: |
| Wall time | 7,200 seconds | 86,400 seconds |
| Total tokens | 400,000 | 10,000,000 |
| Tool calls | 400 | 10,000 |
| Agent iterations | 12 | 64 |
| Each verification item | 60 seconds | fixed by interactive version 1 |

Budgets are aggregate across the full goal. Verification time counts against wall time. The current tool batch may finish
before an observed limit propagates, but the coordinator will not start another iteration after the breach.

## Design precedents

Pigo uses its own session, verifier, receipt, and policy implementations. The lifecycle choices follow proven boundaries in
other open-source coding agents:

- [OpenHands conversation state](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/state.py) persists execution status, aggregate statistics, maximum iterations, and stuck detection for resume.
- [OpenHands pause and resume](https://docs.openhands.dev/sdk/guides/convo-pause-and-resume) treats pause as an explicit lifecycle operation rather than a prompt convention.
- [SWE-agent trajectories](https://github.com/SWE-agent/SWE-agent/blob/main/docs/usage/trajectories.md) retain per-step action, observation, state, exact model query, and a repeatable configuration artifact.
- [Aider](https://github.com/Aider-AI/aider) automatically runs lint and tests after changes and can feed failures back into repair.
- [OpenAI Codex](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs) exposes explicit session resume instead of pretending a fresh prompt is durable recovery.
- [Goose session settings](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/environment-variables.md) separate context strategy and turn ceilings for unattended work; Pigo similarly keeps long-run ceilings explicit but adds frozen verification and receipt policy.

The differences are deliberate: Pigo's completion verdict comes from its frozen deterministic checks and receipt policy, and
repeated unchanged evidence stops instead of retrying without bound.
