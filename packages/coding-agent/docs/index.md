# Pigo Documentation

Pigo is a fast, governed terminal coding agent. It stays small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, and packages.

## Quick start

Install Pigo with npm:

```bash
npm install -g --ignore-scripts pi-gogogo
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Pigo does not require install scripts for normal npm installs.

To uninstall Pigo:

```bash
npm uninstall -g pi-gogogo
```

For pnpm, Yarn, or Bun installs, use the matching global remove command with `pi-gogogo`.

Then run it in a project directory:

```bash
pigo
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting Pigo.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using Pi](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Verifiable runs](verified-runs.md) - execute a bounded task, independently verify changes, and emit an integrity receipt.
- [Agent CI gates](agent-ci.md) - run `pigo ci` with no paths to gate the latest project receipt, or enforce batch policy offline.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [llama.cpp](llama-cpp.md) - run a local router and manage models with `/llama`.
- [Security](security.md) - project trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](containerization.md) - sandbox pi with Gondolin, Docker, or OpenShell.
- [Settings](settings.md) - global and project settings.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Pi packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) - embed pi in Node.js applications.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Environment variables](environment-variables.md) - Pi process configuration and session metadata available to bash tools.
- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.
- [Local evaluations](evals.md) - run deterministic offline smoke checks and compare a saved baseline.
- [Agent CI gates](agent-ci.md) - turn concrete run receipts into a stable automation or merge decision.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
