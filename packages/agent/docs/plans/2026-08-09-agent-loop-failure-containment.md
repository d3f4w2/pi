# Agent Loop Failure Containment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure low-level Agent streams turn producer failures into terminal Agent events instead of detached unhandled promise rejections.

**Architecture:** Attach a final rejection boundary to the low-level stream producer, collect completed messages at the event sink, and reuse one assistant failure-message factory across low-level and stateful APIs. Keep direct promise APIs and process-global error behavior unchanged.

**Tech Stack:** TypeScript, `EventStream`, Vitest.

---

### Task 1: Write low-level failure regressions

**Files:**
- Modify: `packages/agent/test/agent-loop.test.ts`

**Step 1:** Add a test whose stream function throws before returning a provider stream.

**Step 2:** Assert iteration completes with `message_start`, `message_end`, `turn_end`, and `agent_end` failure events.

**Step 3:** Add continuation and abort classification cases.

**Step 4:** Run:

```text
node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts
```

Expected: new tests fail because the detached producer currently has no rejection handler.

### Task 2: Add the shared failure factory

**Files:**
- Create: `packages/agent/src/run-failure.ts`
- Modify: `packages/agent/src/agent.ts`

**Step 1:** Move assistant failure message construction into `createAgentFailureMessage()`.

**Step 2:** Use it from `Agent.handleRunFailure()` without changing stateful behavior.

### Task 3: Contain low-level producer failures

**Files:**
- Modify: `packages/agent/src/agent-loop.ts`

**Step 1:** Record completed messages in each low-level stream sink.

**Step 2:** Attach a rejection handler to the producer promise.

**Step 3:** Emit the standard failure lifecycle and always close the stream.

**Step 4:** Run the focused test and expect all cases to pass.

### Task 4: Document and verify

**Files:**
- Modify: `packages/agent/README.md`
- Modify: `packages/agent/CHANGELOG.md`

**Step 1:** Document low-level failure semantics.

**Step 2:** Run Agent regressions for loops, state, and repeated tool failures.

**Step 3:** Run `npm run check` and fix every reported issue.

**Step 4:** Stage only milestone files, commit, and push `fork/main`.
