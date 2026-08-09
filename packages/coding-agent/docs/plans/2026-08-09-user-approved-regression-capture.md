# User-Approved Regression Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the main agent turn recovered real failures into minimal project regression tests only after explicit user review before generation and before file creation.

**Architecture:** Add a pure failure tracker, a bounded regression draft validator/writer, and a temporary internal `eval_case` tool coordinated by the existing evals extension. The tool is inactive during normal work, can use no companion tools while a grant is active, and creates only new test files after a second confirmation.

**Tech Stack:** TypeScript, TypeBox, Vitest, Node.js filesystem and crypto APIs, Pi extension lifecycle and UI APIs.

---

### Task 1: Track recovered failures

**Files:**
- Create: `packages/coding-agent/src/extensions/evals/failure-tracker.ts`
- Test: `packages/coding-agent/test/eval-capture.test.ts`

1. Write tests for recovered tool errors, verification failures, unresolved failures, aborts and bounded fingerprints.
2. Run the focused test and confirm it fails because the tracker is missing.
3. Implement the pure tracker without retaining tool input, output, paths or prompts.
4. Run the focused test and confirm it passes.

### Task 2: Validate and atomically create approved tests

**Files:**
- Create: `packages/coding-agent/src/extensions/evals/regression-cases.ts`
- Modify: `packages/coding-agent/src/extensions/evals/types.ts`
- Test: `packages/coding-agent/test/eval-capture.test.ts`

1. Add failing tests for valid minimal drafts, traversal, overwrite, non-test paths, secrets, control characters and rollback.
2. Define the bounded draft and approved-case metadata.
3. Implement validation, full preview formatting, exclusive file creation, rollback and metadata persistence.
4. Run the focused test and confirm it passes.

### Task 3: Add two-stage approval to the agent

**Files:**
- Modify: `packages/coding-agent/src/extensions/evals/index.ts`
- Test: `packages/coding-agent/test/eval-capture.test.ts`

1. Add a test harness for lifecycle events, active tools, UI choices and sent user messages.
2. Verify recovered failures offer allow, reject and suppress choices.
3. Register `eval_case` inactive by default; activate it only after the first approval.
4. Block every other tool while the grant is active.
5. On submit, validate and preview the complete draft, ask for the second approval, then write or discard it.
6. Revoke the grant and restore active tools after submit, expiry or an unused generation turn.

### Task 4: Document and verify

**Files:**
- Modify: `packages/coding-agent/docs/evals.md`
- Modify: `packages/coding-agent/docs/agent-platform-roadmap.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

1. Document the two approvals, storage locations, privacy boundary and test-file limitations.
2. Run `eval-capture`, `evals`, `run-metrics` and browser focused tests.
3. Run `npm run check`.
4. Review staged paths, commit, push, and verify the remote commit.
