# ADR 0014: Semantic TUI visual system

## Status

Accepted on 2026-08-09.

## Problem

Pi already has themes, selectors, tool output, messages, and a footer, but each component decides its own visual hierarchy. A selected menu row may color its description like its label, tool cards use large background areas, and the footer treats important model state like low-priority token statistics. The result works, but users must read more text than necessary to understand state.

The interface must also remain safe at narrow terminal widths. A visual improvement that creates long untruncated rows can crash the TUI renderer.

## Decision

Use the "restrained professional" style:

- Keep layout quiet and dense; do not add permanent sidebars or decorative boxes.
- Present the product as `pi-go`: lightweight, clear, and fast.
- Show a large responsive `pi-go` logo only during startup. Use a compact wordmark during normal work.
- Keep the default startup surface quiet: show the brand and one short action hint, but do not print loaded context, skills, prompts, extensions, themes, or conflict details.
- Treat `Ctrl+O` as the disclosure control for startup details as well as tool output. Expanding reveals loaded resources and diagnostics; collapsing removes them from the visible transcript. `--verbose` keeps the detailed startup view available for debugging.
- Reuse the existing loader timer with a short forward-moving animation; never add artificial waiting or extra animation timers.
- Use color semantically: accent for focus, green for success or enabled, yellow for warning or confirmation, red for failure or denial, and muted gray for secondary detail.
- Color the smallest useful element, such as a cursor, state marker, or value. Avoid large colored backgrounds.
- Give every list the same hierarchy: cursor, primary label, secondary description or value, then contextual hint.
- Show tool calls as state plus operation. Keep detailed output available without making it visually compete with the conversation.
- Treat footer fields as prioritized segments. Preserve project, model, mode, and context state before optional token statistics.
- Degrade by terminal width: remove descriptions and optional metrics before truncating primary labels.
- Measure every rendered line with `visibleWidth()` and truncate with `truncateToWidth()`.

Existing theme colors remain the source of truth. This change does not hardcode a new palette and does not require custom themes to add tokens.

Brand color is not state color. The wordmark uses the normal text and accent colors; green, yellow, and red remain reserved for success, warning, and error states.

## Motion

Motion must communicate activity rather than decorate the screen. Startup may briefly reveal the wordmark, while ongoing work uses one fixed-width three-cell forward indicator. Animations stop as soon as the operation completes, keep the surrounding text stationary, and fall back to a static marker when animation frames are disabled.

The logo has three responsive forms: full block logo at 72 columns or wider, compact two-line logo from 40 to 71 columns, and the `pi-go ›` wordmark below 40 columns.

## Component boundaries

`packages/tui` owns reusable list layout and width safety. It does not know Pi-specific colors or labels.

`packages/coding-agent` maps theme colors to semantic roles and owns conversation, tool, selector, and footer presentation.

Extensions may keep custom screens, but their focus, state colors, hints, and truncation must follow the same rules.

## Consequences

The common list components improve many commands at once. Custom extension menus can migrate without changing their stored settings or command behavior. The design adds rendering tests at narrow and normal widths so future features cannot reintroduce overflow.
