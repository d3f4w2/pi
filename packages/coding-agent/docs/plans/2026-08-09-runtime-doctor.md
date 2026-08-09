# Runtime Doctor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a fast, read-only `/doctor` command that explains whether Pi's core and project-relevant capabilities are ready and gives exact Chinese remediation without exposing secrets.

**Architecture:** A pure diagnostic engine consumes a bounded runtime snapshot and injectable filesystem probes. A hidden built-in extension collects model/tool/settings state, renders a bounded report, and exposes it only through `/doctor`, so normal model turns gain no tool schema.

**Tech Stack:** TypeScript, Pi extension commands, SettingsManager, ModelRegistry, Node filesystem/path APIs, Vitest.

---

### Task 1: Define the check model and failing engine tests

**Files:**
- Create: `packages/coding-agent/src/extensions/doctor/types.ts`
- Create: `packages/coding-agent/test/doctor-checks.test.ts`

**Steps:**

1. Define severity, area, finding, runtime snapshot and dependency types.
2. Test Windows Git Bash and PATHEXT resolution, legacy WSL rejection and Unix executable resolution.
3. Test bounded root-marker language detection without recursive scanning.
4. Test core model/tool failures, project-relevant LSP advice and optional mgrep/web findings.
5. Test that simulated secrets never appear in findings or formatted output.
6. Run the test and confirm it fails before the engine exists.

### Task 2: Implement the pure diagnostic engine

**Files:**
- Create: `packages/coding-agent/src/extensions/doctor/checks.ts`
- Create: `packages/coding-agent/src/extensions/doctor/report.ts`

**Steps:**

1. Implement bounded executable resolution from explicit paths, known Git Bash paths and PATH entries.
2. Implement current-root language detection.
3. Implement independent model, tool, shell, LSP, mgrep, web and config checks.
4. Implement deterministic sorting, summary counts, severity selection and 12,000-character formatting.
5. Run `doctor-checks.test.ts` until all cases pass.

### Task 3: Define failing extension integration tests

**Files:**
- Create: `packages/coding-agent/test/doctor-extension.test.ts`

**Steps:**

1. Capture command registration and fake Extension API/context state.
2. Test `/doctor` status lifecycle, notification severity and cleanup after errors.
3. Test that command registration adds no model tool.
4. Confirm the tests fail before the extension exists.

### Task 4: Implement and register `/doctor`

**Files:**
- Create: `packages/coding-agent/src/extensions/doctor/index.ts`
- Modify: `packages/coding-agent/src/extensions/index.ts`

**Steps:**

1. Collect settings, model and tool state without reading credential contents.
2. Run the pure engine and notify the bounded Chinese report.
3. Register the extension as hidden and command-only.
4. Run both doctor test files.

### Task 5: Document, regress, commit and push

**Files:**
- Create: `packages/coding-agent/docs/doctor.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

**Steps:**

1. Document output levels, checks, privacy guarantees and fixes.
2. Run doctor, shell-routing, LSP, tools and model-registry related tests.
3. Run `npm run check` and fix all warnings and errors.
4. Stage only doctor milestone files, including this ignored plan with `git add -f`.
5. Commit and push `fork/main`.
