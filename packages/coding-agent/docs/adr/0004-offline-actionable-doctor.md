# ADR-0004: Use Offline Evidence for Actionable Runtime Diagnostics

## Status

Accepted

## Context

Pi now includes optional search, LSP, verification, web, provider, and shell-routing capabilities. Their dependencies differ by project and platform. When one is unavailable, users currently see the failure only after a task has already started, and may confuse an optional dependency failure with a broken agent.

Oh My Pi publicly documents `/debug` for debugging, reporting, and profiling. This fork also needs a beginner-facing answer to a different question: “Can my current project use the important capabilities, and what exact action fixes the missing ones?”

An online self-test would be more realistic, but it would add latency, network uncertainty, credential exposure risk, and possible paid provider requests.

## Decision

- Add a built-in hidden extension that registers the user command `/doctor`.
- Keep it command-only; do not expose another model tool schema.
- Build diagnostics from offline evidence already available in the current process plus bounded filesystem and PATH probes.
- Classify findings as `ok`, `info`, `warning`, or `error` according to whether they are optional, project-relevant, or core-blocking.
- Attach one concise Chinese remediation to every non-OK finding.
- Treat individual probes as isolated: one failure cannot abort the report.
- Never read credential contents, run installers, start servers, access the network, or call a model.

## Consequences

### Positive

- Diagnosis is fast, deterministic, free, and safe to repeat.
- Optional tools remain optional and cannot make the whole agent appear broken.
- Language-server advice is relevant to the current project instead of always warning about every language.
- Reports are understandable without requiring users to inspect logs or know Pi internals.
- Normal model turns pay no additional tool-schema token cost.

### Negative

- File presence proves discoverability, not that a remote service or executable will work perfectly at runtime.
- Root-marker detection can miss unconventional project layouts.
- The check engine must stay aligned with shell and LSP resolution rules as those evolve.

### Neutral

- `/doctor` reports fixes but never performs them.
- Existing startup warnings remain useful for immediately blocking configuration errors.
- Deep endpoint tests can be added later only as explicit opt-in operations if evidence shows they are needed.

## Alternatives Considered

### Call every service and executable

Rejected as the default because it can hang, fail for transient external reasons, leak operational metadata, or incur paid requests.

### Add a `doctor` model tool

Rejected because environment health is primarily user-initiated and a permanently registered schema would consume tokens on unrelated turns.

### Extend `/debug` only

Rejected because debugging internals and giving a beginner an actionable health report are different workflows and audiences.

## References

- [Runtime Doctor Architecture](../doctor-architecture.md)
- [Oh My Pi README: `/debug`](https://github.com/can1357/oh-my-pi)
