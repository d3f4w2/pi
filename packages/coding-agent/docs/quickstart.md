# Quickstart

This page gets you from install to a useful first Pigo session.

## Install

Pigo is distributed as an npm package:

```bash
npm install -g --ignore-scripts pi-gogogo
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Pigo does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed Pigo:

```bash
# npm
npm uninstall -g pi-gogogo

# pnpm
pnpm remove -g pi-gogogo

# Yarn
yarn global remove pi-gogogo

# Bun
bun uninstall -g pi-gogogo
```

Uninstalling Pigo leaves settings, credentials, sessions, and installed packages in `~/.pi/agent/`.

Then start Pigo in the project directory you want it to work on:

```bash
cd /path/to/project
pigo
```

## Authenticate

Pigo can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start Pigo and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching pi:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pigo
```

You can also run `/login` and select an API-key provider to store the key in `~/.pi/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once Pigo starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Pigo gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Pigo runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give pi project instructions

Pigo loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Pigo loads:

- `~/.pi/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

If a directory contains `AGENTS.override.md`, Pi loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory.

Restart Pigo, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
pigo @README.md "Summarize this"
pigo @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model and its thinking level. Use Shift+Tab to cycle tool safety mode. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
pigo -c                  # Continue most recent session
pigo -r                  # Browse previous sessions
pigo --name "my task"    # Set session display name at startup
pigo --session <path|id> # Open a specific session
```

Inside pi, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
pigo -p "Summarize this codebase"
cat README.md | pigo -p "Summarize this text"
pigo -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

### Run and verify an engineering task

For work that needs an independent result rather than only an Agent response:

```bash
pigo run "Fix the parser regression and add a focused test"
pigo ci
```

`pigo run` stores a privacy-safe integrity receipt in Pigo's private data directory. `pigo ci` automatically finds the latest
receipt for the current Git project, verifies it offline, and applies `pigo.ci.json` from the project root when that file exists.
Use `pigo ci --all` to evaluate every stored receipt for the project.

## Next steps

- [Using Pi](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Pi Packages](packages.md) - install shared extensions, skills, prompts, and themes.
- [Verifiable runs](verified-runs.md) - bounded Agent execution with independent checks and integrity receipts.
- [Agent CI gates](agent-ci.md) - zero-model receipt policy enforcement for local automation and CI.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
