# Context Cache Proof Experiment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add and run a reproducible experiment that strictly proves Pi preserves the provider-visible cache prefix and reports provider cache hits only when the provider supplies positive cache telemetry.

**Architecture:** A standalone TypeScript experiment builds one deterministic conversation and derives cache-aware and legacy-pruned variants using production context-hygiene code. Its dry-run path captures the exact OpenAI Responses payloads before network I/O, compares UTF-8 byte prefixes, and fails unless all structural invariants hold. Its live path sends exactly three single-turn requests—original warm-up, cache-aware variant, legacy variant—with one shared cache key, recording only payload digests, timings, token usage, and cache counters.

**Tech Stack:** TypeScript, Node.js strip-only execution, Vitest, Pi OpenAI Responses transport.

---

### Task 1: Replace the Earlier Cache-Control Probe

**Files:**
- Replace: `packages/coding-agent/test/sdk-openai-responses-cache-ab.ts`

1. Build deterministic original, cache-aware, and legacy message arrays.
2. Capture exact provider payloads with `onPayload` and no network access.
3. Compute hashes, byte lengths, and longest common UTF-8 prefixes.
4. Assert that cache-aware pruning preserves the deep result, prunes a tail duplicate, and shares a longer prefix with the original than legacy pruning.
5. Add a live mode that sends exactly three requests and never enables the rejected explicit-breakpoint fields.
6. Classify server cache proof as positive only when `usage.cacheRead` is positive; otherwise report it as unproven.

### Task 2: Run the Deterministic Proof

**Files:**
- Test: `packages/coding-agent/test/sdk-openai-responses-cache-ab.ts`

1. Run `node test/sdk-openai-responses-cache-ab.ts --dry-run` from the package directory.
2. Require exit code zero and `clientPrefixProof: "proven"`.
3. Record the emitted hashes and prefix measurements.

### Task 3: Run the Bounded Provider Probe

**Files:**
- Test: `packages/coding-agent/test/sdk-openai-responses-cache-ab.ts`

1. Run `node test/sdk-openai-responses-cache-ab.ts --live` once.
2. Enforce the hard limit of three provider requests in code.
3. Record only provider/model identifiers, timings, normalized usage, cache counters, and payload digests.
4. Do not infer cache hits from latency alone.

### Task 4: Preserve the Complete Experiment Record

**Files:**
- Create: `packages/coding-agent/docs/experiments/2026-08-10-context-cache-prefix-proof.md`
- Modify: `packages/coding-agent/docs/adr/0030-cache-aware-context-pruning.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

1. Document hypothesis, controls, exact commands, request count, raw sanitized measurements, assertions, and limitations.
2. Separate the proven client property from the provider-side verdict.
3. Link the executable experiment from ADR-0030.

### Task 5: Verify and Commit

**Files:**
- Test all cache-related files modified in this session.

1. Run the focused Vitest files from the package root.
2. Run the dry-run experiment again.
3. Run `npm run check` from the repository root.
4. Run `git diff --check`.
5. Stage only the cache implementation, tests, experiment, ADR, plan, docs, and changelog paths.
6. Review staged diff and commit with an approved repository-format message.
