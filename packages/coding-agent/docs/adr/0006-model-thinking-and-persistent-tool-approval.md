# ADR 0006: Model thinking selection and persistent tool approval

## Problem

Thinking-level shortcuts are unreliable across terminals, and model capability determines which thinking levels are valid. Tool confirmation also becomes repetitive when the user has already decided to always allow or deny a tool.

For example, `Ctrl+Shift+Tab` may never reach Pi, while two approval modes look identical when both are tested only with terminal commands.

## Decision

- Remove the app-level thinking-cycle shortcut.
- Keep thinking-level control in `/settings` and integrate it into `/model`.
- Make `/model` a two-step flow: select a model, then select one of that model's supported thinking levels.
- Apply and persist the model and thinking level only after the final selection. Cancelling the second step changes nothing.
- Define safety modes as:
  - `yolo`: prompt only for explicitly dangerous operations.
  - `write`: prompt for write and execute operations; allow reads.
  - `always-ask`: prompt for every tool operation.
- Add persistent per-tool decisions to the approval dialog:
  - always allow the tool;
  - always deny the tool.
- Persist these decisions in `settings.json` under `tools.approval`.
- Explicitly dangerous operations continue to require confirmation even when the tool is allowlisted.

## Why

Thinking level belongs to the selected model, so keeping both choices in one flow avoids invalid combinations and terminal-specific shortcuts. Persistent tool policies remove repeated prompts without weakening the existing critical-operation guard.

## Consequences

- Selecting a reasoning model takes one additional confirmation.
- Strict mode is intentionally noisy because it includes read-only tools.
- A persistent deny blocks immediately; users can change it later in settings.
