# ADR 0033: Default to one lightweight OS-enforced sandbox

- Status: Accepted
- Date: 2026-08-10
- Scope: coding-agent subprocesses, file tools, network access, extensions, approvals, and packaging

## Context

Pi currently executes model-selected commands and developer tools with the host user's authority. The existing sandbox example wraps only `bash`, supports Linux and macOS, and falls back to unsandboxed execution when initialization fails. That is not a security boundary: background processes, verification, LSP, DAP, browser, and in-process file tools can bypass it.

The product requirement is one safe default with no Docker, VM, or WSL prerequisite. Users should not need to understand platform sandbox primitives or maintain path lists. A sandbox failure must be visible and fail closed.

## Decision

1. Pi exposes three user-facing modes: `auto` (default), `read-only`, and `full-access`.
2. `auto` allows writes in the active workspace and a Pi-owned temporary directory. `read-only` allows no workspace writes. Built-in file tools protect Pi control data, Git control data, environment files, credentials, and paths outside the workspace.
3. Built-in shell and search subprocesses plus extension calls through `pi.exec()` use one asynchronous process broker. Direct Node process calls from trusted extensions and host-control subsystems remain outside this boundary.
4. Linux and macOS use `@anthropic-ai/sandbox-runtime`: Bubblewrap plus namespaces/seccomp on Linux and Seatbelt on macOS.
5. Windows uses a bundled restricted-token launcher aligned with the current Codex unelevated design. A deterministic workspace capability SID grants writes only to the workspace/private temp roots, protected-path deny ACLs cover control data, and a Job Object limits and terminates the process tree. The launcher is copied to a private content-addressed path and verified before every use.
6. Sandboxed environments use an allowlist and never receive provider keys, tokens, session paths, or arbitrary host environment variables.
7. Linux, macOS, and the separate-user Windows backend keep an empty static network allowlist. An interactive request for a concrete `host:port` can be approved for the current command, current session, or current workspace; unmatched, ambiguous, cancelled, and headless requests fail closed. The Windows unelevated restricted token cannot enforce network or general read isolation; these limitations are surfaced instead of being represented as enforced.
8. Built-in file tools enforce the same resolved-path policy before host filesystem calls. Symlink resolution cannot broaden an allowed root.
9. In-process extensions, language servers, debug adapters, package installers, and other host-control subsystems remain explicitly trusted host code. Untrusted extensions are not represented as sandboxed until the out-of-process extension protocol from ADR 0020 is implemented.
10. Sandbox enforcement and tool approval remain separate. Approval can narrow or authorize a brokered request, but it cannot disable enforcement. `full-access` is an explicit user choice.
11. Missing dependencies, unsupported policies, launcher errors, and proxy setup failures reject the operation. Pi never silently falls back to host execution.

## Alternatives

### Run all of Pi in a container or micro-VM

This gives a clear boundary but adds a large image, slow startup, volume mapping, and poor native Windows integration. It remains an optional high-assurance backend, not the default.

### Productize the current sandbox example

This is small but protects only `bash`, passes broad host environment state, and fails open. It creates misleading coverage and is rejected.

### Depend on another complete coding-agent CLI for its sandbox binary

This avoids native work but adds hundreds of megabytes and couples Pi to an unstable internal command protocol. It is rejected as neither lightweight nor maintainable.

## Consequences

- Normal users get one default with no setup screen.
- Linux still needs usable unprivileged namespaces; required helper binaries must be packaged or diagnosed precisely.
- Windows defaults to native PowerShell because Git Bash/MSYS currently fails under restricted tokens. Git Bash is available only with explicit `full-access`.
- Exact Windows host-read and network isolation requires an elevated dedicated account/firewall backend or a container/VM.
- Persistent network grants are exact-destination records under the Pi agent directory. They do not carry credentials, support wildcards, or permit port-less requests.
- Private registries still need a future credential broker; network authorization never exposes raw host credentials to the subprocess.
- Trusted in-process extensions retain host authority and must be labeled honestly.
