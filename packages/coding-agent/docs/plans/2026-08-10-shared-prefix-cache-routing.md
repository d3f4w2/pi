# Shared-Prefix Prompt Cache Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve implicit OpenAI Responses cache routing across coding-agent sessions that share the same project, model, system prompt, and tool definitions without changing model-visible content or making provider calls.

**Architecture:** Transform only the existing `prompt_cache_key` after extensions have produced the final request payload. Derive a bounded privacy-preserving SHA-256 key from the project scope, provider/model identity, system/developer prefix, tool definitions, and structured-output shape; exclude dynamic transcript messages. Preserve extension-defined keys and keep the independent session-affinity headers unchanged.

**Tech Stack:** TypeScript, Node.js `crypto`, Vitest, existing provider payload hook.

---

### Task 1: Specify shared-prefix key behavior

**Files:**

- Create: `packages/coding-agent/test/prompt-cache-optimizer.test.ts`

1. Write a failing test proving two sessions with identical stable request shape but different user tails and session keys receive one shared key.
2. Write failing tests proving the key rotates when project scope, model, system prompt, tool schema, or structured-output shape changes.
3. Write failing tests proving non-Responses payloads, disabled cache payloads, malformed payloads, and extension-defined keys pass through unchanged.
4. Run the single Vitest file and confirm the missing implementation fails.

### Task 2: Implement the payload optimizer

**Files:**

- Create: `packages/coding-agent/src/core/prompt-cache-optimizer.ts`

1. Extract only cache-relevant stable request fields.
2. Serialize the exact stable shape without prompt text appearing in the output key.
3. Generate `pi-prefix-v1-<sha256>` within OpenAI's 64-character limit.
4. Return a cloned top-level payload with only `prompt_cache_key` changed.
5. Return local diagnostics containing hashes and byte counts for offline proof.
6. Fail open on unsupported or malformed payloads.
7. Run the single Vitest file until all unit cases pass.

### Task 3: Integrate after extension payload transforms

**Files:**

- Modify: `packages/coding-agent/src/core/sdk.ts`
- Test: `packages/coding-agent/test/prompt-cache-optimizer.test.ts`

1. Add an integration test using the SDK payload callback.
2. Capture the original provider-generated key before extension processing.
3. Let `before_provider_request` produce the final request shape.
4. Preserve the extension result when it changed or removed the key.
5. Otherwise apply the shared-prefix optimizer using the resolved working directory as privacy and traffic scope.
6. Verify session-affinity headers continue to use the original session ID.
7. Run the single Vitest file until the integration cases pass.

### Task 4: Document the decision

**Files:**

- Create: `packages/coding-agent/docs/adr/0031-shared-prefix-prompt-cache-routing.md`

1. Record the exact problem, data flow, privacy boundary, 15-RPM consideration, and failure behavior.
2. Record which OpenCode, Oh My Pi, and Aider ideas were adopted or rejected.
3. State that the change affects routing metadata only, not model-visible prompts, tools, history, or execution.

### Task 5: Verify and commit

1. Run the focused Vitest file.
2. Run the existing offline cache experiment dry-run.
3. Run `npm run check`; distinguish failures in unrelated concurrent work from feature failures.
4. Review the full diff and staged paths.
5. Stage only the optimizer, SDK integration, focused test, plan, and ADR.
6. Commit with the repository's required message format without pushing.
