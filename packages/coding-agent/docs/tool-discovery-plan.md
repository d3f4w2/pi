# Dynamic Tool Discovery and Budget Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate persisted tool permission from runtime tool exposure, then add a bounded `tool_search` that activates at most two low-frequency tools for the next model step.

**Architecture:** Tools opt into discovery through metadata. The tools extension owns the persisted enabled pool and derives the runtime active set from eager tools plus the latest bounded discovery result. Disabling `tool_search` restores the existing eager behavior.

**Tech Stack:** TypeScript, TypeBox, Pi extension API, Vitest.

---

## Task 1: Define discovery behavior with failing tests

**Files:**

- Create: `packages/coding-agent/test/tool-discovery.test.ts`
- Modify: `packages/coding-agent/test/tools-extension.test.ts`
- Modify: `packages/coding-agent/test/agent-session-dynamic-tools.test.ts`

1. Add tests for Chinese keywords, English keywords, exact-name priority and stable ordering.
2. Add a test proving results are capped at two.
3. Add tests proving disabled tools are excluded and a second search replaces prior matches.
4. Add a test proving `tool_search` disabled restores every allowed tool.
5. Add a test proving discovery metadata reaches `pi.getAllTools()`.
6. Run the three tests and confirm they fail for the missing feature.

Run from `packages/coding-agent`:

```text
node ../../node_modules/vitest/dist/cli.js --run test/tool-discovery.test.ts test/tools-extension.test.ts test/agent-session-dynamic-tools.test.ts
```

## Task 2: Add discovery metadata and pure selection logic

**Files:**

- Modify: `packages/coding-agent/src/core/extensions/types.ts`
- Modify: `packages/coding-agent/src/core/agent-session.ts`
- Create: `packages/coding-agent/src/extensions/tools/discovery.ts`

1. Add an optional, erasable TypeScript discovery metadata type to `ToolDefinition` and `ToolInfo`.
2. Pass metadata through `AgentSession.getAllTools()`.
3. Implement deterministic local scoring without external services.
4. Implement runtime active-set derivation with a two-tool discovery budget.
5. Run `tool-discovery.test.ts` and the agent-session regression test.

## Task 3: Register tool_search and separate the two states

**Files:**

- Modify: `packages/coding-agent/src/extensions/tools/index.ts`
- Modify: `packages/coding-agent/src/extensions/tools/ui.ts`

1. Register the always-available `tool_search` tool.
2. Load persisted preferences into an enabled-name set at session start.
3. Derive active tools instead of treating active tools as preferences.
4. Make `/tools` read and write the enabled-name set.
5. Replace prior discovered matches when a new search succeeds.
6. Keep the current active set unchanged on no match.
7. Restore eager behavior when `tool_search` is disabled.
8. Run `tools-extension.test.ts`.

## Task 4: Opt low-frequency built-ins into discovery

**Files:**

- Modify: `packages/coding-agent/src/extensions/ast-grep/index.ts`
- Modify: `packages/coding-agent/src/extensions/code-search/index.ts`
- Modify: `packages/coding-agent/src/extensions/verify/index.ts`
- Modify: `packages/coding-agent/src/extensions/web/index.ts`

Add short Chinese and English keywords that describe user intent. Do not hide core tools or third-party tools by default.

## Task 5: Update user-facing documentation

**Files:**

- Modify: `packages/coding-agent/docs/tools.md`
- Modify: `packages/coding-agent/docs/tools-architecture.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

Explain that `[开]` means allowed, describe the fallback when `tool_search` is off, link the architecture document, and add an `[Unreleased]` changelog entry.

## Task 6: Verify the closed loop

1. Run the specific modified tests.
2. Start a controlled Pi session and verify the initial tool list contains eager tools but not discoverable tools.
3. Ask for a web or structural-search task and verify `tool_search` loads the expected tool for the following model step.
4. Open `/tools`, disable `tool_search`, restart, and verify all allowed tools are exposed.
5. Run `npm run check` from the repository root and fix all reported errors, warnings and infos.
6. Review `git diff` and confirm unrelated files such as `tmp/` and desktop test files were not changed.
