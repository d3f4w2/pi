# Context lifecycle architecture

## Problem

Long coding tasks need two different histories:

- a complete local history for inspection, audit, tree navigation, and recovery;
- a smaller active model context that retains decisions and evidence without resending every search, read, failure, and diagnostic.

Compaction already protects the context window, and provider context hygiene removes redundant tool output from individual requests. Neither feature gives the user an explicit exploration boundary, a previewable evidence report, or a reversible way to stop sending an explored branch while retaining it locally. Turn undo restores files and must not be reused for context changes.

## Requirements and invariants

The implementation must:

- keep session JSONL append-only and retain the complete session tree;
- preserve every user requirement, deterministic evidence identifier, failed test, approval decision, and untrusted-content marker in the active view;
- keep the exact message prefix before a checkpoint whenever the session tree still contains it;
- require preview and confirmation before a rewind or restore;
- detect session, workspace, runtime, and multi-window changes between preview and apply;
- restore the prior active context if an apply step fails;
- make no model call for checkpoint creation, preview, rewind, restore, or metrics;
- add no provider input or model call when the feature is unused;
- never write rewind output into long-term memory or self-evolution storage;
- never modify Git state or restore files.

## Architecture

```text
/context or context_lifecycle tool
              |
              v
  ContextLifecycleService
    | checkpoint metadata       | deterministic report
    | preview/CAS guard          | token/cache metrics
    v                            v
SessionManager read view     Context mutation host
    |                            |
    | append custom entry        | navigateTree(checkpoint)
    |                            | append rewind report
    |                            | append active-view marker
    v                            v
append-only session JSONL and session tree
```

`ContextLifecycleService` owns checkpoint discovery, report generation, guards, metrics, and recovery rules. It depends on a narrow host adapter. The built-in extension supplies that adapter with existing extension APIs: `navigateTree`, `sendMessage`, and `appendEntry`. Tests can use an in-memory adapter without a model.

No session entry type or JSONL version changes. The feature uses versioned extension entries:

- `pi.context.checkpoint.v1`: checkpoint metadata;
- `pi.context.checkpoint-deleted.v1`: logical tombstone;
- `pi.context.rewind-report.v1`: the only model-visible rewind report;
- `pi.context.active-view.v1`: restore reference and metrics, not model-visible;
- `pi.context.view-restored.v1`: makes a restored branch the last append-only leaf;
- `pi.context.view-rollback.v1`: records a failed apply recovery.

Interactive tool approval also appends `pi.tool-approval-decision.v1`, a non-model-visible record containing the tool call ID, risk tier, redacted reason/details, exact user choice, and allow/deny outcome. This closes the prior gap where an allowed choice could exist only in transient UI state. Rewind projects these records into the approval section and evidence manifest.

### Checkpoint data

A checkpoint stores:

- a random checkpoint ID and optional normalized name;
- session ID and the checkpoint entry's parent leaf as the message boundary;
- creation time, current Git branch, and a bounded workspace summary;
- active message and branch-entry counts;
- estimated input tokens;
- SHA-256 content and workspace digests;
- a short role/tool/content-size summary.

It never stores message bodies. At most 20 non-deleted checkpoints may exist in one session. Deletion appends a tombstone rather than rewriting JSONL.

### Rewind preview

Preview resolves a checkpoint on the current branch and builds two views:

1. `before`: the current compaction-aware session context;
2. `after`: the exact context at the checkpoint plus one deterministic report.

The report walks the complete branch segment after the checkpoint, including entries that a later compaction removed from the active provider view. It emits the following required sections:

- confirmed facts;
- verbatim post-checkpoint user requirements;
- file and line evidence;
- modifications;
- tests and diagnostics;
- failed attempts and why not to repeat them;
- unresolved work and todos;
- user decisions still required;
- approval/refusal, untrusted-content, model, tool, mode, trust, and safety state;
- a deterministic evidence manifest.

Every post-checkpoint user message, tool call, tool result, context summary, and approval decision receives an evidence ID containing its session entry or tool-call ID and a content digest. Evidence text is compacted, but evidence IDs are never sampled or capped. User messages are retained verbatim. This gives a deterministic retention check while keeping large tool output out of the report.

Preview reports:

- active messages before and after;
- messages leaving the active context;
- estimated tokens before and after and reduction percentage;
- deterministic evidence count and retained count;
- user-message count and retained count;
- report generation time;
- exact reusable prefix message/token counts and invalidated suffix tokens;
- whether the original leaf is recoverable.

### Compare-and-swap guard

Preview captures a guard over:

- session ID, current leaf, branch digest, and entry count;
- persistent JSONL size, modification time, and SHA-256 when a file exists;
- workspace status digest and current branch;
- current model, active tools, runtime mode, project trust, and approval settings.

Apply captures the same guard after confirmation. Any difference fails closed before navigation. This detects a new user message, another window appending to the same session, a workspace change, or a relevant runtime/safety change.

After append, persistent sessions are compared with the in-memory entry sequence. A foreign or interleaved entry is treated as a conflict. The attempted branch remains in the append-only audit history, while the active leaf is returned to the original branch and a rollback marker is appended.

### Apply and restore

Apply performs:

```text
verify preview guard
  -> navigate to checkpoint custom entry
  -> append one model-visible rewind report
  -> append non-visible active-view marker with original leaf
  -> validate active context and persistent mirror
```

The original branch is never deleted or modified. Restore previews the target active-view marker, confirms, navigates to its original leaf, and appends a non-visible restore marker with the measured restore duration. Nested rewinds therefore restore in stack order. Messages created on a rewound branch remain visible in the session tree even when restoring the prior branch.

If report generation fails, no navigation occurs. If confirmation is rejected, no entry or leaf changes. If apply or restore fails after navigation, the service navigates back to the starting leaf and appends a rollback marker. If even rollback persistence fails, the in-process leaf is still restored and the command reports that persisted recovery must be inspected.

## Collaboration with existing context systems

### Compaction

Checkpoint entries and active-view markers are custom entries and do not enter model context. A rewind report is a custom message, so later compaction treats it as a turn boundary and may summarize only the active branch. Rewinding to a checkpoint before a compaction creates a new branch before that compaction; the old compaction entry remains on the original branch and is recovered with it.

### Provider context hygiene

Hygiene still runs on the transient provider request after the session view is built. It may prune tool output that occurs after a rewind, but it cannot change the stored report or original branch.

### Prompt cache

Rewind never rewrites messages before the checkpoint. Metrics calculate the exact common message prefix between the old and new active views. The stable project/system/tool routing key is unchanged unless runtime state changed; the conversation suffix after the checkpoint is intentionally invalidated. The report records reusable prefix tokens and invalidated suffix tokens so the cache tradeoff is visible.

### Session tree, fork, clone, and resume

The active view is an ordinary append-only branch. Tree navigation exposes both the full exploration branch and the report branch. Fork and clone copy the chosen branch using existing behavior. Resume selects the last appended active-view, restore, or rollback marker, which makes the intended branch deterministic without a mutable sidecar pointer.

### Turn undo

Rewind does not call turn undo and never touches files. Turn undo may restore workspace files independently; such a workspace change invalidates an outstanding rewind preview through the workspace digest.

### Memory and self-evolution

The extension does not emit memory or learning events and does not call their tools. Rewind reports remain session-local. Candidate, learning, web, and tool execution paths cannot apply rewind: only the explicit `/context` command has the mutation host and confirmation path. The model-callable tool supports checkpoint creation and read-only inspection, not apply, delete, or restore.

## Interfaces

`/context` is the only top-level command. It provides an interactive menu and scriptable subcommands:

```text
/context
/context create [name]
/context list
/context delete <checkpoint>
/context preview <checkpoint>
/context rewind <checkpoint>
/context restore [view]
/context savings
```

`context_lifecycle` is discoverable through the existing tool-discovery mechanism. Its actions are `create`, `list`, `preview`, and `savings`. It cannot apply rewind or restore. In production it is inactive until discovered, so an unused checkpoint feature adds no provider tool schema, input token, or model call.

TUI and RPC use their confirmation UI. ACP, print, JSON, or any host without confirmation capability fails closed for rewind, restore, and logical deletion.

## Failure boundaries

| Failure | Boundary | Result |
| --- | --- | --- |
| No checkpoint or checkpoint from another branch | Before report | No mutation |
| Report extraction error | Before preview | Original context unchanged |
| User rejects preview | Confirmation | Original context unchanged |
| Session/workspace/runtime changes after preview | Guard compare | Conflict; no mutation |
| Another window appends during apply | Persistent mirror validation | Restore original leaf; keep failed branch as audit history |
| Navigation fails | First apply step | Original context unchanged |
| Report or marker append fails | Apply transaction | Restore original leaf and record rollback when possible |
| Restore target missing | Before restore | Current view unchanged |
| No confirmation protocol | Command boundary | Fail closed |
| Git command unavailable | Workspace snapshot | Record unavailable state; do not change Git |
| Memory, learning, web, or model tool requests rewind | Authorization boundary | Tool offers preview only; no mutation host |

## Quantitative evaluation

All fixtures are local and deterministic. The long-task integration uses the faux provider and makes no external API call.

Required fixtures:

1. repeated unsuccessful searches;
2. code modification followed by a failed test;
3. a new user requirement after checkpoint;
4. approval and refusal records;
5. session change after preview;
6. rewind followed by full-context restore.

Acceptance metrics:

- typical long-task active input token reduction: at least 25%;
- deterministic evidence retention: 100%;
- user-message retention: 100%;
- successful full-context restoration: 100%;
- unused feature: zero additional model calls and zero active provider tool tokens;
- report generation and restore duration recorded in milliseconds;
- exact reusable prompt-cache prefix change recorded in messages and estimated tokens.

Observed faux-provider run on 2026-08-10:

| Metric | Result |
| --- | ---: |
| Active messages | 29 → 3 |
| Estimated input tokens | 48,910 → 7,850 |
| Estimated token reduction | 41,060 (84.0%) |
| Report generation | 20.7 ms |
| Restore | 0.2 ms |
| Exact prompt-cache prefix | 2 messages / 13 estimated tokens |
| Invalidated suffix | 48,897 estimated tokens |
| Deterministic evidence | 98/98 retained (100%; omitted: no) |
| Post-checkpoint user messages | 1/1 retained (100%) |
| Full-context restore | 1/1 successful (100%) |
| Unused-feature provider calls | 1 baseline / 1 with extension |
| Unused-feature active tool schema | Exact baseline match; `context_lifecycle` absent |

The durations are single-run observations and are not pass/fail thresholds. Message, token, cache-prefix, and retention values are deterministic for the fixture. The test suite also covers persistent multi-window append detection, preview failure, rejected confirmation, partial-apply rollback, and the 20-checkpoint limit.
