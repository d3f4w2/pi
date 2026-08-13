# ADR 0049: Receipt-native Agent CI gates

## Status

Accepted

## Problem

Pigo already has two different kinds of evidence:

- model-backed eval suites compare prompts, tools, skills, models, and agents across repeated scenarios;
- `pigo run` emits privacy-safe, integrity-protected receipts for concrete repository work.

The eval suites are useful for product research, but they are not a suitable default merge gate. They may call paid models,
vary statistically, and persist prompts, source code, responses, or tool output. A CI decision must instead be deterministic,
offline, bounded, and explainable from artifacts that are safe to retain.

For example, a run can finish with exit code zero while changing files outside its declared scope, exceeding an organization
token limit, or producing no independent verification. CI needs to reject that evidence without rerunning the model.

## Decision

Add a standalone `pigo ci` command that consumes one or more `pigo run` receipt files or directories.

The command:

1. discovers receipt JSON files without following symbolic links;
2. validates the complete receipt schema and SHA-256 integrity envelope;
3. evaluates each valid receipt against a strict versioned policy;
4. evaluates aggregate cost, token, duration, and tool-call limits;
5. emits stable text or JSON and exits with a documented code.

`pigo ci` never starts an Agent, loads a session, resolves a model, reads credentials, or performs network requests. It is a
fast top-level command, like `pigo doctor`. `pigo run` is moved to the same standalone dispatch path so receipt execution help
and receipt checking do not pay normal application startup cost.

### Policy schema

Version 1 policies use these sections:

- `allowedOutcomes`: acceptable receipt outcomes;
- `requirements`: unchanged HEAD, scope compliance, verification for changes, all checks passing, required check IDs, and
  optional organization-approved scope roots;
- `perRunLimits`: duration, total tokens, estimated cost, tool calls, tool errors, and protocol errors;
- `aggregateLimits`: total duration, tokens, cost, and tool calls across the batch.

Unknown fields fail closed. Omitted policy sections inherit strict defaults. Receipt integrity validation cannot be disabled
by policy.

The built-in policy accepts `verified` and `completed` outcomes, requires unchanged HEAD and scope compliance, requires
verification for changed workspaces, requires every recorded check to pass, and allows zero tool or protocol errors. It does
not impose organization-specific token, cost, duration, scope-root, or required-check limits.

### Inputs and output

Positional inputs may be receipt files or directories. Directories are searched recursively for `.json` files in stable
lexicographic order. Duplicate files are evaluated once. Symbolic links, oversized receipt files, missing inputs, an empty
input set, and invalid policies are invocation errors.

An individual malformed or tampered receipt is a gate failure, not an invocation failure, so a complete batch report still
identifies every bad artifact.

Exit codes are:

- `0`: every receipt and aggregate rule passed;
- `1`: at least one receipt, integrity check, per-run rule, or aggregate rule failed;
- `2`: command usage, policy, discovery, or required input failed.

JSON reports contain only receipt-relative evidence: file names, run IDs, outcomes, metrics, and policy violations. They do
not recover or persist prompts, responses, source, tool arguments, or tool output.

## Why this is separate from model-backed evals

Model-backed evals answer “is candidate A better than baseline B under repeated scenarios?” Receipt-native CI answers “did
these concrete engineering runs satisfy an explicit governance contract?” Combining them would make deterministic merge
gates depend on statistical and potentially paid execution.

The two layers can be composed later: eval suites may produce `pigo run` receipts, and `pigo ci` can gate those receipts.
The receipt remains the boundary between execution and policy.

## Consequences

- CI can validate Agent work without API keys or model access.
- Policy decisions are reproducible from retained artifacts.
- Invalid evidence is visible in one batch report instead of failing at the first file.
- Versioned strict schemas require explicit evolution when new governance dimensions are added.
- SHA-256 integrity detects accidental or post-run mutation but is not an identity signature. Signed attestations remain a
  future trust-layer decision.

