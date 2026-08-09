# ADR 0013: Interactive permissions manager

## Problem

Persistent tool allow and deny rules already exist, but users can only remove or change them by editing `settings.json`. This makes a safety feature hard to understand and easy to misconfigure.

`/tools` cannot absorb this responsibility cleanly: a tool being enabled answers whether the model may see it, while a permission rule answers whether execution needs confirmation. Combining both states in one row would make the interface ambiguous.

## Decision

- Add a separate `/permissions` command to the built-in tools extension.
- Show every registered tool and its effective risk tier.
- Support four per-tool policies:
  - `follow`: remove the override and follow the current safety mode;
  - `prompt`: ask every time;
  - `allow`: always allow ordinary operations from this tool;
  - `deny`: always block this tool.
- Use Up/Down to select and Left/Right to cycle policies.
- Keep edits in a local draft. Enter saves changed policies; Escape discards the draft.
- Reuse `SettingsManager` as the only persistence owner through narrow extension-context methods.
- Keep critical-operation checks above user allow rules, so allowlisting a tool cannot bypass destructive-operation confirmation.

## Why

The separate command keeps tool availability and execution permission understandable. Draft editing makes cancellation reliable. Reusing the existing settings manager preserves locking, normalization, and the current `tools.approval` format.

## Consequences

- Extensions receive read access to the current approval snapshot and a narrow setter for one tool policy.
- Removed tools with stale rules are not shown; their inactive settings remain harmless until the tool is registered again.
- Saving several changed tools may perform several small locked settings writes. The tool list is small, so a bulk settings API is unnecessary.
