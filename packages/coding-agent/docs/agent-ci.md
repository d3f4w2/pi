# Agent CI gates

`pigo ci` turns one or more [`pigo run`](verified-runs.md) receipts into a deterministic merge decision. It validates the
receipt schema and SHA-256 integrity record, applies an explicit policy, aggregates resource use, and returns a stable exit
code without loading a model or session.

## Quick start

Run an engineering task, then check its latest receipt with no path management:

```bash
pigo run "Fix the parser regression and add a focused test"
pigo ci
```

The same offline evaluator is available from the terminal state of interactive `/run`:

```text
/run
→ 独立验收回执
```

This `/run` action passes the exact terminal receipt to the same integrity validation, policy evaluator, and report formatter.
It does not ask the active model to judge its own work. Batch history and explicit exported paths remain shell concerns through
`pigo ci --all` or `pigo ci <path>`.

Pigo stores default receipts outside the repository in a private directory partitioned by Git workspace. To check every
stored receipt for the current project instead of only the latest:

```bash
pigo ci --all
```

Explicit files and directories remain available for exported artifacts and hosted CI:

```bash
pigo ci artifacts/pigo-runs
```

Use an organization policy and emit a machine-readable report:

```bash
pigo ci artifacts/pigo-runs --policy pigo.ci.json --json > artifacts/pigo-ci-report.json
```

The evaluator is offline. It does not initialize providers, read credentials, start an Agent, or contact a network service.
The interactive façade uses the already-open session only to display the deterministic report.

## Built-in policy

When `--policy` is omitted, Pigo first looks for `pigo.ci.json` in the project root in zero-input mode, or in the current
directory when explicit receipts are supplied. If no file exists, it uses the built-in policy. The built-in policy:

- accepts only `verified` and `completed` outcomes;
- rejects a changed Git HEAD;
- rejects final changes outside the run contract's scope;
- requires successful independent verification when the workspace changed;
- requires every recorded verification check to pass;
- allows zero tool-execution errors and zero Agent event-protocol errors.

It does not assume organization-specific Token, cost, duration, tool-call, required-check, or scope-root limits. Add those
limits in a policy file.

## Policy file

Policy schema version 1 is strict: unknown fields, invalid types, negative limits, absolute scope roots, and paths that leave
the workspace are rejected.

```json
{
  "version": 1,
  "allowedOutcomes": ["verified", "completed"],
  "requirements": {
    "headUnchanged": true,
    "scopeCompliant": true,
    "verificationForChanges": true,
    "allChecksPassed": true,
    "requiredChecks": ["typecheck", "test"],
    "allowedScopes": ["packages/app/src", "packages/app/test"]
  },
  "perRunLimits": {
    "durationMs": 900000,
    "totalTokens": 50000,
    "costUsd": 2,
    "toolCalls": 100,
    "toolErrors": 0,
    "protocolErrors": 0
  },
  "aggregateLimits": {
    "totalDurationMs": 1800000,
    "totalTokens": 100000,
    "totalCostUsd": 4,
    "totalToolCalls": 200
  }
}
```

### Requirements

| Field | Default | Meaning |
| --- | --- | --- |
| `headUnchanged` | `true` | Reject runs that commit, reset, switch, or otherwise move Git HEAD. |
| `scopeCompliant` | `true` | Reject any path in the receipt's `workspace.scopeViolations`. |
| `verificationForChanges` | `true` | Require at least one successful independent verification result when files changed. |
| `allChecksPassed` | `true` | Reject failed, unavailable, or timed-out recorded checks. |
| `requiredChecks` | `[]` | Require a passing check with every listed check ID. |
| `allowedScopes` | `[]` | Restrict each run contract scope to one of these repository-relative roots. Empty means no additional restriction. |

An allowed scope root contains itself and descendants. For example, `packages/app` permits `packages/app/src` but not `.` or
`packages/other`. A policy root of `.` permits every declared scope.

### Limits

`perRunLimits` applies separately to each valid receipt. `aggregateLimits` applies to the sum of all valid receipts in the
invocation. A metric fails only when it is greater than its limit.

Estimated cost is the provider-reported receipt value. Missing provider pricing is represented by the execution layer before
the receipt reaches CI; `pigo ci` does not invent a cost estimate.

## Input discovery

With no positional input, Pigo resolves the current Git workspace, opens only that workspace's private receipt partition,
and evaluates its latest receipt by modification time. Equal timestamps use a deterministic path tie-break. `--all` evaluates
the entire current-project partition. A missing or empty partition is an invocation error with a `pigo run` recovery hint.

Positional inputs may be regular files or directories. Directories are searched recursively, and only `.json` files are
selected. Results are de-duplicated and sorted before evaluation, so reports remain stable across platforms.

Pigo does not follow symbolic links. A receipt may be at most 2 MiB, and one invocation may evaluate at most 10,000 receipts.
These bounds keep an accidentally broad or hostile artifact directory from turning a CI check into an unbounded filesystem
scan or memory load.

An invalid or tampered receipt is retained in the report as `receipt.invalid`; evaluation continues for the rest of the
batch. Missing inputs, unsafe discovery, an empty result set, and an invalid policy are invocation errors.

## Reports and exit codes

Text output is designed for humans:

```text
Pigo CI gate: PASS
Policy: pigo.ci.json · sha256:...
PASS artifacts/run.json · 01915f45-... · verified
Summary: 1/1 passed · 18420 tokens · 37 tool calls · $0.4280
```

`--json` writes one stable version-1 report containing:

- the effective policy source and hash;
- per-file validity, run ID, outcome, and violation codes;
- batch counts;
- aggregate duration, Token, cost, and tool-call metrics;
- aggregate policy violations.

The report contains no task text, assistant response, source code, tool arguments, tool output, or credentials.

| Exit code | Meaning |
| ---: | --- |
| `0` | Every receipt and aggregate policy passed. |
| `1` | At least one receipt, integrity check, per-run rule, or aggregate rule failed. |
| `2` | Command usage, policy, discovery, or required input failed. |

## CI example

The same command works in any CI runner with Node.js and the `pi-gogogo` package installed:

```yaml
- name: Install Pigo
  run: npm install -g --ignore-scripts pi-gogogo

- name: Gate Agent receipts
  run: pigo ci artifacts/pigo-runs --policy pigo.ci.json --json
```

Store the JSON report as an ordinary CI artifact if later review or trend analysis is required. Keep the original receipts as
the independently verifiable evidence layer.

## Trust boundary

Receipt integrity is a mutation check, not an identity signature. It proves that a receipt still matches its own canonical
SHA-256 digest; it does not prove which machine or person created it. Repositories that need provenance should sign or attest
the receipt artifact in their existing CI identity system. The policy and receipt formats deliberately keep that future trust
layer separate from execution semantics.
