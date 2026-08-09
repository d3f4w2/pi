# Todo Task Ledger Implementation Plan

This plan is executed task by task with a failing-test checkpoint before each implementation layer.

**Goal:** Add a durable, versioned todo state machine that keeps the main agent oriented through long tasks and requires evidence before completion.

**Architecture:** A built-in extension owns a pure reducer and persists successful state snapshots as branch-local custom session entries. Tool calls use stable IDs and optimistic revisions; session lifecycle hooks restore the latest valid snapshot and inject only a bounded open-work summary.

**Tech Stack:** TypeScript, TypeBox, Pi extensions, append-only SessionManager entries, Vitest.

---

### Task 1: Define state and failing reducer tests

**Files:**
- Create: `packages/coding-agent/src/extensions/task-ledger/types.ts`
- Create: `packages/coding-agent/test/task-ledger-state.test.ts`

**Steps:**

1. Define bounded schemas and stable state types.
2. Test plan creation, monotonic IDs, one active task, auto progression, completion evidence, blocking, reopen, removal, and clear.
3. Test revision conflicts and atomic failure.
4. Run the test and confirm it fails before the reducer exists.

### Task 2: Implement the pure state machine

**Files:**
- Create: `packages/coding-agent/src/extensions/task-ledger/state.ts`

**Steps:**

1. Implement empty state, validation, normalization, reducer and formatting helpers.
2. Implement reverse branch snapshot recovery with corrupt-entry fallback.
3. Run `task-ledger-state.test.ts` until all cases pass.

### Task 3: Define failing extension integration tests

**Files:**
- Create: `packages/coding-agent/test/task-ledger-extension.test.ts`

**Steps:**

1. Capture the registered tool and lifecycle handlers with a fake Extension API.
2. Test persisted custom entries, resume, bounded context injection, widget updates, `/tasks`, and revision errors.
3. Confirm the tests fail before registration exists.

### Task 4: Implement and register the built-in extension

**Files:**
- Create: `packages/coding-agent/src/extensions/task-ledger/index.ts`
- Modify: `packages/coding-agent/src/extensions/index.ts`
- Modify: `packages/coding-agent/src/extensions/tools/discovery.ts`

**Steps:**

1. Register `todo` with concise Chinese descriptions and guidelines.
2. Persist successful mutations with `pi.appendEntry("task-ledger-v1", state)`.
3. Restore and render on session lifecycle events.
4. Add bounded per-run system-prompt context and the `/tasks` command.
5. Run both task-ledger test files.

### Task 5: Document, regress, commit and push

**Files:**
- Create: `packages/coding-agent/docs/task-ledger.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

**Steps:**

1. Document model operations, user behavior and configuration.
2. Run extension, tools, session and compaction regressions.
3. Run `npm run check` and fix all output.
4. Stage only milestone files, including this ignored plan with `git add -f`.
5. Commit and push `fork/main`.
