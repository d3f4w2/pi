# Bilingual Interface Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a persistent `language` setting and a typed Chinese/English message layer for Pi-go's user interface.

**Architecture:** `SettingsManager` stores the global preference as `auto | zh-CN | en`. A small locale controller resolves `auto`, owns the active runtime language, and translates typed keys with English fallback. TUI components receive translated labels while semantic symbols and raw tool/model content remain language-neutral.

**Tech Stack:** TypeScript, Pi TUI components, Vitest.

---

### Task 1: Define locale resolution and typed messages

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/i18n/index.ts`
- Test: `packages/coding-agent/test/i18n.test.ts`

**Steps:**

1. Add failing tests for `auto`, explicit Chinese/English, invalid locale fallback, interpolation, and missing Chinese-key fallback.
2. Run the focused Vitest file and confirm failure.
3. Implement `LanguageSetting`, `UiLanguage`, locale resolution, active-language control, and typed dictionaries.
4. Run the focused test and confirm it passes.

### Task 2: Persist the global language preference

**Files:**
- Modify: `packages/coding-agent/src/core/settings-manager.ts`
- Modify: `packages/coding-agent/test/settings-manager.test.ts`

**Steps:**

1. Add tests for the `auto` default, accepted values, invalid-value fallback, and persistence.
2. Add `language` to `Settings` plus validated getter and setter methods.
3. Verify the focused settings-manager tests.

### Task 3: Add language to the settings interface

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`
- Modify: `packages/coding-agent/test/settings-selector.test.ts`

**Steps:**

1. Add a test that finds the Language row and cycles `auto`, `中文`, and `English` through its callback.
2. Add the language config and callback contracts.
3. Translate settings labels, descriptions, values, submenus, and keyboard hints through the message layer.
4. Recreate the settings list after a language change so the open screen updates immediately.
5. Verify search and narrow-width rendering in both languages.

### Task 4: Connect session startup and live changes

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Test: `packages/coding-agent/test/interactive-mode-status.test.ts`

**Steps:**

1. Initialize the locale controller from `SettingsManager.getLanguage()` before building the visible interface.
2. Pass the current language setting into the settings selector.
3. On change, persist through `SettingsManager.setLanguage()`, update the locale controller, and request a TUI redraw.
4. Verify a language change affects newly rendered UI without restarting.

### Task 5: Migrate Express Track shell copy

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/footer.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/model-selector.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Test: matching component test files

**Steps:**

1. Add paired Chinese/English assertions for visible labels, empty states, and hints.
2. Replace hard-coded Pi-go shell copy with typed message keys.
3. Keep tool output, paths, model names, and semantic rail symbols unchanged.
4. Run all affected component tests.

### Task 6: Document and verify

**Files:**
- Modify: `packages/coding-agent/CHANGELOG.md`

**Steps:**

1. Add the language setting and bilingual TUI to `[Unreleased]`.
2. Run all new and affected focused tests.
3. Run `npm run check` from the repository root.
4. Run `git diff --check` for the implementation files.
