# Smart Read Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic, token-efficient structural outlines to long code reads without weakening exact range reads or reliable-edit anchors.

**Architecture:** A core outline service selects important source lines using the bundled AST parser for TypeScript/JavaScript-family files and bounded lexical rules for Python/Go. `read` automatically uses the outline only for long supported files, while explicit ranges and `mode="full"` remain verbatim. Every summarizer failure falls back to the existing reader.

**Tech Stack:** TypeScript, Node.js, `@ast-grep/napi`, TypeBox, Vitest.

---

### Task 1: Lock the outline protocol

**Files:**

- Create: `packages/coding-agent/test/smart-read.test.ts`

**Steps:**

1. Write failing tests for long TypeScript declaration coverage and omission markers.
2. Add tests for short files, `mode="full"`, explicit `offset/limit`, forced outline, Python, Go, unsupported extensions, compact resources, and parse failure.
3. Run `node ../../node_modules/vitest/dist/cli.js --run test/smart-read.test.ts` from `packages/coding-agent` and confirm the new behavior fails before implementation.

### Task 2: Build the structural outline service

**Files:**

- Create: `packages/coding-agent/src/core/tools/code-outline.ts`
- Modify: `packages/coding-agent/src/core/tools/file-anchors.ts`
- Test: `packages/coding-agent/test/smart-read.test.ts`

**Steps:**

1. Add supported-language detection and size/line thresholds.
2. Parse bundled AST languages and collect prioritized declaration lines.
3. Add Python and Go declaration extraction.
4. Enforce the visible-line budget and produce ordered omission ranges.
5. Add a 64-entry content-revision LRU cache.
6. Add anchored outline formatting.
7. Run the focused test until outline-service cases pass.

### Task 3: Integrate with read

**Files:**

- Modify: `packages/coding-agent/src/core/tools/read.ts`
- Test: `packages/coding-agent/test/smart-read.test.ts`
- Test: `packages/coding-agent/test/reliable-edit.test.ts`

**Steps:**

1. Add `mode: auto | full | outline` to the read schema.
2. Apply outlines only to ordinary text reads with no explicit range.
3. Preserve the file revision in text and result details.
4. Add outline metrics to result details.
5. Make summarizer failures silently use the verbatim path.
6. Update prompt guidance to expand only the needed omitted range.
7. Run smart-read and reliable-edit tests.

### Task 4: Measure and verify the closed loop

**Files:**

- Create: `packages/coding-agent/test/smart-read-benchmark.test.ts` only if deterministic timing assertions are unnecessary; otherwise use a temporary script and remove it.

**Steps:**

1. Measure a long repository TypeScript file in full and outline modes.
2. Require meaningful output reduction without asserting machine-specific timing.
3. Require outline generation to stay within a conservative local latency bound after warm-up.
4. Perform outline -> focused range -> anchored edit on a temporary project.
5. Run relevant read/edit/system-prompt tests.
6. Run `npm run check` from the repository root.

### Task 5: Document and ship

**Files:**

- Create: `packages/coding-agent/docs/smart-read.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

**Steps:**

1. Document automatic behavior, modes, continuation instructions, and fallback.
2. Add one `[Unreleased]` changelog entry.
3. Run `git diff --check` and inspect the staged paths.
4. Commit with `feat(coding-agent): add smart structural reads`.
5. Push normally to `fork/main`.

