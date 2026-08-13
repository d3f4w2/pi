<p align="center">
  <a href="https://github.com/d3f4w2/pi-Gogogo">
    <img src="https://pi.dev/logo-auto.svg" width="120" alt="Pi GoGoGo logo">
  </a>
</p>

<h1 align="center">Pi GoGoGo</h1>

<p align="center">
  <strong>A fast, governed coding agent for real repositories.</strong>
</p>

<p align="center">
  Work from the terminal, keep control of what the agent can do, and extend the workflow without forking the core.
</p>

<p align="center">
  <a href="https://github.com/d3f4w2/pi-Gogogo/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/d3f4w2/pi-Gogogo/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://www.npmjs.com/package/pi-gogogo"><img alt="npm" src="https://img.shields.io/npm/v/pi-gogogo?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-0f766e?style=flat-square"></a>
  <img alt="Node.js 22.19+" src="https://img.shields.io/badge/node-%3E%3D22.19-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Windows, macOS, and Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-334155?style=flat-square">
</p>

## Install

```bash
npm install -g --ignore-scripts pi-gogogo
```

Current public release: [`pi-gogogo@0.84.1`](https://www.npmjs.com/package/pi-gogogo/v/0.84.1). The
2026-08-13 release was installed again from the public npm registry into an empty isolated prefix and
the generated `pigo` command, version metadata, and redacted doctor checks were verified before this
status was documented.

Verify the local runtime, then start it from any terminal or project directory:

```bash
pigo doctor
pigo
```

Pi GoGoGo is built for engineering work that spans more than one file or one prompt: understanding an unfamiliar codebase, implementing a feature, tracing a failure, reviewing a change, running verification, and carrying the result across a long session.

The default experience stays small. Deeper capabilities are loaded when the task needs them, and project-specific behavior remains explicit.

<p align="center">
  <img src="packages/coding-agent/docs/images/interactive-mode.png" width="860" alt="Pi GoGoGo interactive coding agent">
</p>

## A coding agent you can shape

| | |
| --- | --- |
| **Work deeply** | Read and change repositories, search code, run commands, debug failures, inspect Git history, and verify the result in one session. |
| **Stay in control** | Project trust, tool approval, workspace boundaries, and OS-level isolation keep execution visible and bounded. |
| **Extend the workflow** | Add TypeScript extensions, skills, prompt templates, themes, MCP servers, and reusable packages without changing the core. |
| **Keep the thread** | Saved sessions, compaction, context checkpoints, rewind, and scoped memory support work that takes more than a few turns. |

### Fast by default

The terminal interface streams model output and tool activity as they happen. Optional integrations are discovered lazily, repeated work is cached where it is safe, and an unavailable add-on does not block the main session.

### Governed execution

The agent does not treat a confirmation prompt as a security boundary. Project trust controls what local configuration may load; tool approval controls the requested action; workspace policy constrains paths and operation types; the process layer applies the available operating-system sandbox.

### Evidence that CI can enforce

Run a bounded engineering task, then gate its independently verified receipt without copying an artifact path. Pigo stores
default receipts in a private directory partitioned by project; it does not store the prompt, response, source, tool output,
or raw project path in the receipt.

```bash
pigo run "Fix the parser and add a focused test"
pigo ci
```

`pigo ci` is a deterministic offline gate. It verifies receipt integrity and can enforce allowed outcomes, approved scope roots,
required checks, per-run limits, and aggregate Token, cost, duration, or tool-call budgets without starting another model.
It automatically uses `pigo.ci.json` from the project root when present. Explicit receipt paths and `--policy` remain available
for exported CI artifacts.

### A goal loop that corrects itself

Inside interactive Pigo, `/run` turns the current session into a durable engineering loop. The original goal, allowed scope,
checks, and aggregate budgets stay fixed; only the current plan changes.

```text
/run --scope src --scope test --verify auto:. 修复解析器并补回归测试
```

That is the only interactive entry. Enter bare `/run` afterward to view evidence, pause, resume, provide a required decision,
stop safely, or gate the final receipt. The control center shows only actions legal for the current state. Starting through
bare `/run` also offers bounded 30-minute, 2-hour, and 8-hour presets.

Pigo executes one Agent iteration, runs the frozen checks outside the model, feeds the exact remaining gap into the next
iteration, and repeats. It stops only when the Agent reports completion and independent checks pass, a budget is exhausted,
the same evidence stops changing, the user pauses it, or one concrete product decision is required. Checkpoints survive in
the session; interrupted active runs require explicitly opening `/run` and choosing continue. During active work, pause or
stop first closes the Agent mutation boundary; during verification, the request is applied before any replanning. A terminal
run writes the same private receipt accepted inside `/run` or by shell `pigo ci`.

See [Durable goal loop](packages/coding-agent/docs/goal-loop.md) for state, budget, recovery, and trust-boundary details.

### One runtime, several interfaces

Use the same agent interactively, in scripts, through an editor, or inside another application.

| Interface | Best for |
| --- | --- |
| Interactive TUI | Daily repository work with streaming tools, approvals, and saved sessions |
| Print and JSON | One-shot prompts and automation |
| RPC | Process integration over the native protocol |
| ACP | Editor-hosted agent sessions |
| TypeScript SDK | Embedding the runtime in another application |

## Get started

1. Install the package.

   ```bash
   npm install -g --ignore-scripts pi-gogogo
   ```

2. Start `pigo` and connect a provider.

   ```text
   pigo
   /login
   ```

3. Give it a real task.

   ```text
   Map the authentication flow, identify its trust boundaries, and show me the evidence before changing code.
   ```

You can also authenticate with provider API keys. Model selection, provider setup, and subscription login are available inside the terminal UI.

## Built to grow with the work

Pi GoGoGo keeps the core focused and moves specialized behavior into composable pieces:

- Extensions add tools, commands, events, UI components, and provider behavior.
- Skills package repeatable instructions and domain workflows.
- Packages distribute extensions, skills, prompts, and themes through npm or Git.
- MCP connects external tools and resources behind the same trust and approval flow.
- ACP connects the agent to compatible editors without creating a separate runtime.

Install and manage packages from the same CLI:

```bash
pigo install npm:@scope/package
pigo list
pigo update --all
pigo config
```

## Safety is part of the product

Pi GoGoGo separates trust, approval, workspace policy, and OS enforcement because they solve different problems. A trusted project may still request a dangerous command; an approved command must still stay inside the permitted workspace and sandbox.

TypeScript extensions run in the host process and can call Node.js APIs directly. Review extension code before enabling it. Use a container, VM, or micro-VM for hostile repositories or unattended work.

Read the [security model](packages/coding-agent/docs/security.md) before using the agent on sensitive systems.

## Documentation

| Topic | Start here |
| --- | --- |
| Installation and first session | [Quick start](packages/coding-agent/docs/quickstart.md) |
| CLI and product reference | [Coding agent README](packages/coding-agent/README.md) |
| Extensions and packages | [Extensions](packages/coding-agent/docs/extensions.md) · [Packages](packages/coding-agent/docs/packages.md) |
| MCP and editor integration | [MCP](packages/coding-agent/docs/mcp.md) · [ACP](packages/coding-agent/docs/acp.md) |
| Automation and embedding | [RPC](packages/coding-agent/docs/rpc.md) · [SDK](packages/coding-agent/docs/sdk.md) |
| Verifiable execution and CI | [Durable goal loop](packages/coding-agent/docs/goal-loop.md) · [Verifiable runs](packages/coding-agent/docs/verified-runs.md) · [Agent CI gates](packages/coding-agent/docs/agent-ci.md) |
| Security and isolation | [Security](packages/coding-agent/docs/security.md) · [Windows](packages/coding-agent/docs/windows.md) |
| Performance | [Performance](packages/coding-agent/docs/performance.md) |
| Engineering record in Chinese | [中文工程档案](packages/coding-agent/docs/engineering-portfolio.zh-CN.md) |

## Develop from source

Requirements: Node.js `>=22.19.0` and Git.

```bash
git clone https://github.com/d3f4w2/pi-Gogogo.git
cd pi-Gogogo
npm install --ignore-scripts
npm run check
./test.sh
./pi-test.sh
```

On Windows, start the source build with:

```powershell
.\pi-test.ps1
```

The published command is `pigo`. Existing `.pi` data directories and `PI_*` environment variables remain unchanged so current sessions and configuration continue to work.

## Project lineage

Pi GoGoGo is built from the [Pi agent harness](https://github.com/earendil-works/pi) and retains its MIT license, package layout, and extension model. This repository develops the governed execution, code intelligence, integration, and context-management layers around that core.

New contributors should read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before opening an issue or pull request.

## License

[MIT](LICENSE)
