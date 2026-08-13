# ADR 0050: Project-scoped private run discovery

## Status

Accepted

## Problem

`pigo run` writes privacy-safe receipts outside the repository, while `pigo ci` originally required at least one receipt file
or directory. The safe workflow therefore required users to copy an opaque path from one command into the next. Moving
receipts into every repository would simplify discovery but pollute project state and increase accidental commit or disclosure
risk.

A flat private receipt directory also mixes unrelated repositories. Making zero-input CI scan every receipt would allow a run
from one workspace to affect another workspace's decision, and evaluating all historical receipts by default would make one
old failure block the daily workflow indefinitely.

## Decision

Default run receipts are stored below the agent data directory in a workspace partition:

```text
runs/by-workspace/<sha256(normalized-git-root)>/<run-id>.json
```

Windows workspace roots are case-folded and use portable separators before hashing. Other platforms preserve case. The raw
workspace path is not added to the receipt or CI report.

`pigo ci` without positional inputs resolves the current Git root, derives the same partition, and evaluates the newest
regular JSON receipt by modification time. Equal timestamps use the lexicographically greatest display path as a deterministic
tie-break. `pigo ci --all` evaluates the complete current-project partition.

Explicit files and directories retain their existing batch behavior and do not require a Git workspace. `--all` cannot be
combined with explicit inputs because explicit inputs already define the complete evaluation set.

Policy resolution uses this precedence:

1. explicit `--policy`;
2. `pigo.ci.json` in the resolved project root for zero-input mode, or current directory for explicit-input mode;
3. the built-in strict version-1 policy.

No `go`, `check`, or `init` aliases are added. The existing `run` and `ci` concepts become simpler instead of being duplicated.

## Consequences

- The normal verified workflow is two commands with no receipt path or setup step.
- Receipts remain private and do not change repository status.
- Zero-input selection cannot cross repository partitions.
- Historical failures are opt-in through `--all` or explicit inputs.
- Renaming or moving a repository creates a new local partition because the normalized root changes.
- Modification time chooses the convenient latest artifact; SHA-256 envelope validation still decides whether its contents are
  valid.
- Existing flat receipts remain usable through explicit input paths but are not implicitly searched.

## Alternatives considered

**Add shorter command aliases**

Rejected. Aliases reduce characters but increase the number of concepts, help entries, and support paths.

**Write `.pigo/runs` inside the repository**

Rejected as the default because it mutates project state and requires ignore-file management. Explicit `--receipt` remains
available when repository-local or exported artifacts are intentional.

**Evaluate every private receipt by default**

Rejected because unrelated workspaces and obsolete failures must not affect the current project's normal gate.
