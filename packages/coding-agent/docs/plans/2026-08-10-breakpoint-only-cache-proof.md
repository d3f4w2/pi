# Breakpoint-Only Cache Proof Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Determine whether the configured third-party `gpt-5.6-terra` endpoint accepts `prompt_cache_breakpoint` without `prompt_cache_options`, and whether the field measurably improves cached-token reuse.

**Architecture:** Add a standalone experiment that reuses the production OpenAI Responses transport, intercepts each outbound payload, converts only the stable system block to an `input_text` block with an explicit breakpoint, and deliberately removes `prompt_cache_options`. A dry run proves the three payloads differ only where intended. A live run makes at most three requests with retries disabled and stops immediately after any failure.

**Tech Stack:** TypeScript, Node.js strip-only execution, existing coding-agent model registry, existing OpenAI Responses transport.

---

## Task 1: Build and validate the experiment payloads

**Files:**

- Create: `packages/coding-agent/test/sdk-openai-responses-breakpoint-only-ab.ts`

1. Generate a stable system prefix longer than the provider's documented 1,024-token cache threshold.
2. Build three requests with one shared session/cache key and distinct user suffixes:
   - breakpoint warm-up;
   - breakpoint candidate hit;
   - implicit-cache control.
3. Add a payload transformer that:
   - adds `prompt_cache_breakpoint` only to the first two system blocks;
   - never adds `prompt_cache_options`;
   - preserves the same stable system text and cache key in all variants.
4. Make dry-run mode the default and assert all invariants before allowing live mode.
5. Print hashes and sizes instead of prompt text or credentials.

## Task 2: Run the bounded live experiment

**Files:**

- Run: `packages/coding-agent/test/sdk-openai-responses-breakpoint-only-ab.ts`

1. Execute dry-run mode and review the payload assertions.
2. Execute live mode once against the configured `rayin-gpt/gpt-5.6-terra` model.
3. Disable SDK retries and cap the run at three attempted requests.
4. Stop after the first provider error.
5. Require the exact expected output for every successful response.
6. Compare `cacheRead` for the breakpoint candidate and implicit control.

## Task 3: Record evidence and decision

**Files:**

- Create: `packages/coding-agent/docs/experiments/2026-08-10-breakpoint-only-cache-proof.md`
- Modify: `packages/coding-agent/docs/adr/0030-prompt-cache-aware-context-pruning.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

1. Record the hypothesis, request order, payload hashes, sanitized provider results, and exact verdict.
2. State clearly whether breakpoint-only requests are supported by this endpoint.
3. Separate measured facts from follow-up recommendations.

## Task 4: Verify and commit

1. Re-run the dry payload assertions.
2. Run `npm run check` and fix every reported problem.
3. Review the complete diff and repository status.
4. Stage only files created or modified for this experiment.
5. Commit the complete experiment and evidence with the repository's required commit format.
