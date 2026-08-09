# Semantic TUI Visual System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebrand the visible TUI as `pi-go` and apply a lightweight, professional, color-semantic visual hierarchy to startup, menus, messages, tool output, and footer without breaking narrow terminals or custom themes.

**Architecture:** Improve shared list rendering in `packages/tui`, then map Pi's existing theme tokens to semantic component states in `packages/coding-agent`. Keep layout and width handling separate from Pi-specific colors so extensions remain compatible.

**Tech Stack:** TypeScript, `@earendil-works/pi-tui`, ANSI terminal rendering, Node test runner, Vitest.

---

### Task 1: Lock menu hierarchy with tests

**Files:**
- Modify: `packages/tui/test/select-list.test.ts`
- Modify: `packages/tui/test/settings-list.test.ts`

**Step 1:** Add tests proving the cursor, selected label, and description are styled independently.

**Step 2:** Add widths of 24, 40, and 80 columns and assert every rendered line stays within the requested width.

**Step 3:** Run `node --test test/select-list.test.ts test/settings-list.test.ts` from `packages/tui`; expect the new hierarchy test to fail before implementation.

### Task 2: Improve shared menu components

**Files:**
- Modify: `packages/tui/src/components/select-list.ts`
- Modify: `packages/tui/src/components/settings-list.ts`

**Step 1:** Render selected prefixes with `selectedPrefix`, selected primary text with `selectedText`, and descriptions with `description`.

**Step 2:** Keep current values aligned on wide terminals and fall back to a compact single-column row on narrow terminals.

**Step 3:** Truncate the final composed line after ANSI styling and verify the Task 1 tests pass.

### Task 3: Make conversation and tool state quieter

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/user-message.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- Create: `packages/coding-agent/test/tui-visual-hierarchy.test.ts`

**Step 1:** Add rendering tests for user messages and pending, successful, and failed tool calls.

**Step 2:** Replace large-area emphasis with a small semantic marker while preserving OSC shell-integration zones.

**Step 3:** Keep renderer-provided tool content intact and ensure all states render safely at 40 and 80 columns.

**Step 4:** Run the new Vitest file from `packages/coding-agent`; expect all cases to pass.

### Task 4: Prioritize footer information

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/footer.ts`
- Create: `packages/coding-agent/test/footer-visual-priority.test.ts`

**Step 1:** Add tests for 40, 80, and 120-column footer rendering.

**Step 2:** Style project, branch, model, thinking level, context warning, and optional usage independently.

**Step 3:** Drop cache and detailed usage segments before project, model, mode, or context state.

**Step 4:** Run the footer test and verify no rendered line exceeds its width.

### Task 5: Migrate custom management menus

**Files:**
- Modify: `packages/coding-agent/src/extensions/tools/ui.ts`
- Modify: `packages/coding-agent/src/extensions/tools/permissions-ui.ts`
- Modify: `packages/coding-agent/test/tools-extension.test.ts`
- Modify: `packages/coding-agent/test/permissions-extension.test.ts`

**Step 1:** Render enabled/allowed states in green, prompt states in yellow, denied states in red, and inactive states in muted gray.

**Step 2:** Keep the selected row accent limited to its cursor and primary label.

**Step 3:** Keep Chinese descriptions short and hide them before primary state when width is limited.

**Step 4:** Run both extension test files and verify persistence behavior is unchanged.

### Task 6: Verify the complete interaction

**Files:**
- Modify only files required to fix failures introduced by Tasks 1-5.

**Step 1:** Run all modified test files with their package-specific commands.

**Step 2:** Run `npm run check` from the repository root and fix every issue caused by this feature.

**Step 3:** Start Pi in a controlled 80x24 terminal and inspect `/model`, `/tools`, `/permissions`, a tool success, and a tool failure.

**Step 4:** Repeat at 120x30 and verify richer details appear without changing keyboard behavior.

### Task 7: Add responsive branding and motion

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/components/brand.ts`
- Create: `packages/coding-agent/test/brand-component.test.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/first-time-setup.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/status-indicator.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

**Step 1:** Test full, compact, and wordmark output at 80, 50, and 30 columns.

**Step 2:** Render the large logo only in startup headers and keep the working header compact after startup.

**Step 3:** Use a fixed-width forward-moving loader frame set through the existing `LoaderIndicatorOptions`; do not create a second timer.

**Step 4:** Verify all logo and loader frames have identical visible width and no rendered line exceeds the terminal width.

### Task 8: Turn startup into a quiet workspace

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/brand.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify: `packages/coding-agent/test/brand-component.test.ts`

**Step 1:** Add a pure startup-detail policy and test that normal startup is collapsed while `Ctrl+O` and `--verbose` reveal details.

**Step 2:** Replace the multi-line collapsed help copy with one short action hint.

**Step 3:** Keep resource loading unchanged, but render resource lists and diagnostics only when the detail policy is expanded.

**Step 4:** Reuse the existing `Ctrl+O` state to rebuild or clear startup details without reloading files, starting another process, or adding a timer.

**Step 5:** Keep brand color separate from success color and verify 24, 50, and 80-column rendering.

### Task 9: Add a stable workbench footer

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/footer.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify: `packages/coding-agent/test/footer-width.test.ts`

**Step 1:** Add tests for explicit `git:branch`, cumulative `total`, compact labels, and 40/80/120-column width safety.

**Step 2:** Render location and runtime as two stable rows with subdued separators and semantic value colors.

**Step 3:** Count input, output, cache read, and cache write usage from assistant, tool, branch-summary, and compaction entries.

**Step 4:** Keep `total`, context, and model ahead of optional cache, hit-rate, and cost segments when width shrinks.

**Step 5:** Prefix transient status feedback with one accent marker while retaining the existing in-place update behavior.

**Step 6:** Run the footer and interactive-mode status tests, then `npm run check`.

### Task 10: Unify the input surface and primary overlays

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/components/panel-chrome.ts`
- Create: `packages/coding-agent/test/panel-chrome.test.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/model-selector.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify: `packages/coding-agent/test/custom-editor-history-keybindings.test.ts`
- Modify: `packages/coding-agent/test/model-selector.test.ts`

**Step 1:** Add width-safe rendering tests for an editor border label and shared panel header/footer.

**Step 2:** Add an optional dynamic label to `CustomEditor`, preserving the native top scroll indicator when long input scrolls.

**Step 3:** Bind the label to conversation/terminal mode and persistent safety level without adding state duplication.

**Step 4:** Add shared panel chrome with one accent marker, muted border rail, and compact configurable key hints.

**Step 5:** Migrate model and thinking selectors to the shared chrome, consistent `›` focus, concise Chinese copy, and width-safe rows.

**Step 6:** Run focused editor, selector, panel, and interactive-mode tests, then `npm run check`.

### Task 11: Apply the Express Track identity

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/theme/dark.json`
- Modify: `packages/coding-agent/src/modes/interactive/theme/light.json`
- Modify: `packages/coding-agent/src/modes/interactive/components/user-message.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify: `packages/coding-agent/test/user-message.test.ts`
- Modify: `packages/coding-agent/test/tool-execution-component.test.ts`
- Create: `packages/coding-agent/test/express-track-theme.test.ts`

**Step 1:** Lock the ice-blue/warm-white palettes and semantic state colors with theme tests.

**Step 2:** Render user messages as a forward marker entering a thin continuation rail while preserving OSC shell zones and width safety.

**Step 3:** Render pending tools with `›`, completed tools with `✓`, failed tools with `×`, and multi-line output on one muted continuation rail.

**Step 4:** Add the forward marker to the editor mode label and keep existing menu and panel `›` cursors.

**Step 5:** Add restrained dry copy only to safe empty states; keep security and destructive messages literal.

**Step 6:** Run focused visual tests, theme contrast checks, and `npm run check`.
