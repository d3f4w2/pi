# Shared-Prefix Cache Live Proof Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Measure the real cache-token and latency effect of stable-prefix routing on the configured `rayin-gpt/gpt-5.6-terra` endpoint with no more than three paid requests.

**Architecture:** Add a bounded OpenAI Responses experiment that sends one optimized warm-up, one session-key control, and one optimized cross-session hit using byte-identical payloads except for `prompt_cache_key`. Treat provider-reported cache tokens as the primary proof and latency as a secondary observation.

**Tech Stack:** TypeScript, Pi OpenAI Responses transport, configured model registry, SHA-256 payload evidence.

---

### Task 1: Add the bounded experiment runner

**Files:**
- Create: `packages/coding-agent/test/sdk-openai-responses-shared-prefix-cache-ab.ts`

**Steps:**
1. Build a deterministic prompt exceeding the provider cache minimum.
2. Capture and normalize all three outbound payloads in dry-run mode.
3. Assert the optimized warm and hit requests share a key, the control key differs, and every other payload byte is identical.
4. In live mode, disable retries, cap output tokens, stop on the first error, and enforce exactly three maximum attempts.
5. Report cache-read tokens, uncached-input tokens, cache-read rate, TTFT, elapsed time, and exact-output preservation.

### Task 2: Prove the payload invariant offline

**Files:**
- Test: `packages/coding-agent/test/sdk-openai-responses-shared-prefix-cache-ab.ts`

**Steps:**
1. Run `node test/sdk-openai-responses-shared-prefix-cache-ab.ts --dry-run` from `packages/coding-agent`.
2. Require a zero exit code and a `proven` payload verdict.
3. Fix the runner if any request field other than `prompt_cache_key` differs.

### Task 3: Run the three-request live experiment

**Files:**
- Test: `packages/coding-agent/test/sdk-openai-responses-shared-prefix-cache-ab.ts`

**Steps:**
1. Run `node test/sdk-openai-responses-shared-prefix-cache-ab.ts --live` once.
2. Do not retry the experiment automatically.
3. Accept a routing advantage only when the optimized hit reports more cache-read tokens than the session-key control.
4. Record latency without treating it as cache proof.

### Task 4: Record and verify the result

**Files:**
- Create: `packages/coding-agent/docs/experiments/2026-08-10-shared-prefix-cache-routing-proof.md`

**Steps:**
1. Write the exact command, environment, payload hashes, provider counters, calculations, verdict, and limitations.
2. Run the experiment dry-run again after documentation.
3. Run `npm run check` from the repository root.
4. Stage and commit only the runner, plan, and experiment report.
