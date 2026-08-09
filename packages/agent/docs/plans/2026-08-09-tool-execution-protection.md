# Tool Execution Protection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every tool timeout-, cancellation-, failure-, and circuit-safe without slowing successful calls or interrupting ordinary coding.

**Architecture:** Agent core owns bounded execution and per-tool circuit state. Coding-agent enables conservative defaults, persists settings, and exposes the bounded state through `/doctor`.

**Tech Stack:** TypeScript, TypeBox tool schemas, Vitest, existing Agent hooks and extension UI.

---

### Task 1: Extend the existing core protection guard

**Files:**
- Modify: `packages/agent/src/tool-failure-guard.ts`
- Test: `packages/agent/test/tool-failure-guard.test.ts`

1. Write failing tests for redaction, caps, timeout, abort, circuit opening, cooldown, and recovery.
2. Run the specific Vitest file and confirm the new behavior is absent.
3. Extend bounded error formatting and the circuit state machine without adding a second guard.
4. Run the specific test until it passes.

### Task 2: Agent-loop integration

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/agent.ts`
- Modify: `packages/agent/src/agent-loop.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/test/agent-loop.test.ts`

1. Write failing integration tests for timeout results, different-argument circuit blocking, cancellation exclusion, and parallel ordering.
2. Add protection settings and diagnostic snapshots to the public types.
3. Apply the circuit before execution and deadline around execution.
4. Normalize all thrown tool and post-hook errors.
5. Run agent-loop and existing failure-guard tests.

### Task 3: Settings and SDK wiring

**Files:**
- Modify: `packages/coding-agent/src/core/settings-manager.ts`
- Modify: `packages/coding-agent/src/core/sdk.ts`
- Modify: `packages/coding-agent/test/settings-manager.test.ts`
- Create: `packages/coding-agent/test/tool-execution-protection-sdk.test.ts`

1. Write failing settings/default/clamping and SDK wiring tests.
2. Add circuit, cooldown, and generic timeout settings.
3. Pass resolved timeout and circuit settings to Agent.
4. Run the targeted settings and SDK tests.

### Task 4: User surfaces and documentation

**Files:**
- Modify: `packages/coding-agent/src/extensions/doctor/types.ts`
- Modify: `packages/coding-agent/src/extensions/doctor/checks.ts`
- Modify: `packages/coding-agent/src/extensions/doctor/index.ts`
- Modify: `packages/coding-agent/docs/settings.md`
- Modify: `packages/agent/CHANGELOG.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

1. Report effective protection settings in `/doctor`.
2. Document timeout, cancellation, circuit recovery, defaults, and examples.
3. Add `[Unreleased]` changelog entries.
4. Run doctor, settings, AgentSession, agent-loop, and failure-guard regressions.

### Task 5: Final verification

1. Run every modified/new specific test file.
2. Run related non-e2e regressions.
3. Run `npm run check` with full output.
4. Inspect `git diff --check` and verify unrelated user files remain untouched.
