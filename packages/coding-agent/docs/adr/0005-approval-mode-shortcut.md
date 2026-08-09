# ADR-0005: Make Approval Mode a First-Class Shortcut

## Status

Accepted

## Problem

Tool approval mode changes how often Pi interrupts the user. Editing `settings.json` is too slow for a state that users may change several times during one development session.

`Shift+Tab` already cycles thinking level, so assigning it directly would silently remove an intentional workflow.

## Decision

- Add the configurable app action `app.approval.cycle` with default key `Shift+Tab`.
- Remove the thinking-cycle shortcut; terminal support for multi-modifier Tab combinations is unreliable.
- Cycle approval modes in this order: `yolo → write → always-ask → yolo`.
- Save each change through `SettingsManager`, so it survives restart.
- Apply the new value immediately because approval is resolved from settings before every tool call.
- Show a short Chinese status message explaining the effective behavior.
- Keep both actions configurable through `keybindings.json`.

## Consequences

- The most common safety control becomes one key press.
- Thinking level is selected as part of `/model`; this decision is superseded by ADR 0006.
- No model request, token usage, tool reload, or session restart is required.
