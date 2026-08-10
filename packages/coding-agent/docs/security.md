# Security

Pi is a local coding agent. Its trusted control plane and extensions run with the permissions of the user account that starts it. Model-controlled built-in tools use the lightweight sandbox described below by default.

## Project Trust

Project trust controls whether pi loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Pi considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.pi/settings.json`
- `.pi/extensions`, `.pi/skills`, `.pi/prompts`, or `.pi/themes`
- `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.pi` directory does not count as a project resource that requires trust.

When an interactive session starts in a project with resources that require trust and no saved decision for the current directory or a parent directory, pi follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.pi/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows pi to load project resources that require trust, including:

- `.pi/settings.json`
- `.pi` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. Context files such as `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, pi only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## Default Lightweight Sandbox

Pi starts model-controlled built-in tools in `auto` mode with no required setup. The mode can be selected before startup:

```bash
PI_SANDBOX_MODE=auto pi          # default: workspace and private-temp writes
PI_SANDBOX_MODE=read-only pi     # workspace reads, private-temp writes
PI_SANDBOX_MODE=full-access pi   # explicit host execution
```

An invalid value or sandbox initialization failure stops the operation instead of falling back to host execution. Sandboxed commands receive an allowlisted environment with a private home and temporary directory; provider keys, Pi session paths, runtime injection variables, and untrusted proxy variables are not passed through. The Pi agent directory itself is included in the sandbox's protected read and write roots.

The built-in `read`, `write`, `edit`, `grep`, `find`, `ls`, and shell tools enforce the canonical workspace policy. Symlink and junction resolution cannot broaden it. Built-in shell execution, search subprocesses, and extension calls through `pi.exec()` use the process broker. Writes to existing `.git`, `.pi`, and `.env*` paths, known credential directories, and paths outside the allowed write roots are denied.

Platform enforcement differs:

- Linux uses Bubblewrap, namespaces, and seccomp. macOS uses Seatbelt. Commands can read most host files except configured credential and control paths, can write only the workspace/private temp roots, and have network access denied by default.
- Windows automatically uses the stronger separate-user backend when its one-time setup is present. The command runs as a dedicated local account, workspace access is granted with session ACLs, and Windows Filtering Platform (WFP) blocks direct network egress. Pi copies the pinned helper into a per-process `ProgramData` directory that the sandbox account can only read and execute, verifies its SHA-256 digest before every launch, and removes it on reset. Startup behaviorally verifies the WFP fence and fails closed if an installed backend is unhealthy.
- Without that setup, Windows uses a restricted token, workspace capability SID, ACLs, and a kill-on-close Job Object without UAC. This zero-setup fallback reliably restricts writes and process-tree resources, but retains host file reads and direct network access. Environment secrets are still removed.

On Linux, macOS, and Windows with the `srt-windows` backend, the static network allowlist is empty. When a sandboxed shell command first requests a concrete destination, interactive modes show one compact selector:

- deny
- allow the exact `host:port` for this command
- allow it for this Pi session
- always allow it for this workspace

The deny choice is selected by default. Numeric IP shorthands are canonicalized before display, and loopback, private/LAN, link-local, multicast, and known metadata targets carry an extra warning. Wildcards, unknown ports, cancelled prompts, and new destinations in non-interactive modes are denied. Concurrent requests for the same destination share one prompt, distinct prompts are serialized, and one command can open at most eight prompts. If several commands are active and the requesting command cannot be identified safely, the new request is denied. Session and workspace grants are checked only while at least one brokered command is active; no command scope means no prompt and no network access.

Workspace grants are stored as private content-addressed records under `~/.pi/agent/network-permissions` (or the configured agent directory). The record contains only the canonical workspace and exact destination, never a credential. Removing that directory while Pi is stopped clears all remembered network grants. A remembered grant permits the destination in headless mode but does not create new grants there.

To enable the stronger Windows backend, run this once in a trusted terminal and accept the single Windows UAC prompt:

```powershell
npx --yes @anthropic-ai/sandbox-runtime@0.0.71 windows-install
```

Pi detects the installation automatically on later starts; there is no per-project configuration. Native PowerShell is the default Windows executor because Git Bash/MSYS is incompatible with the zero-setup restricted-token fallback. Git Bash in that fallback requires explicit `full-access` mode.

Run `/doctor` to see the current sandbox state and selected backend. `srt-windows` identifies the separate-user/WFP backend and supports the network authorization gate; `restricted-token` identifies the zero-setup Windows fallback and cannot enforce it.

Extensions are trusted TypeScript running inside the Pi process. An extension can call Node filesystem or process APIs directly and bypass the built-in broker. Language servers, debug adapters, package installation, UI helpers, and other host-control operations are not represented as isolated unless their implementation explicitly uses the broker. Review extension and package source before installation.

Project trust is only an input-loading guard. It prevents a repository from silently changing pi's settings or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by pi.

## Running Untrusted or Unmonitored Work

For hostile repositories, unattended automation, untrusted extensions, or Windows workloads that cannot use the separate-user backend, run pi in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole `pi` process inside a container/sandbox
- run host pi while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.pi/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](https://github.com/earendil-works/pi-mono/blob/main/SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected documented sandbox limitations, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real boundary bypass or shows how pi grants access beyond the documented policy.
