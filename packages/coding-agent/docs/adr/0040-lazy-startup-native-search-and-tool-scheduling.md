# ADR 0040: Lazy Startup, Native Search, and Ordered Tool Scheduling

## Status

Accepted.

## Problem

On Windows, the existing Node distribution took about 1.3 seconds to print its version even though measured work inside `main()` took about 70 milliseconds. Most time was spent resolving and evaluating hundreds of modules before argument handling. The in-process Windows grep fallback also took about 8 seconds on this repository, compared with roughly 52 milliseconds for native search. Finally, one tool marked `executionMode: "sequential"` forced every call in the same model response to run serially.

## Decision

- The CLI bootstrap handles a standalone version request before loading networking or the application runtime.
- App modes, built-in extensions, external extension support, PDF parsing, and web parsing load through explicit dynamic boundaries.
- Published Node CLIs are minified with esbuild and split into a small bootstrap entry plus lazy chunks. Native, sandbox, and user-extension dependencies stay external.
- Built-in extension modules import concurrently but their factories activate in declared order. External extension modules follow the same two-phase rule.
- Web parsing, MCP clients, LSP services, syntax highlighting, HTML export, and platform sandbox backends load on first use. Lightweight tool schemas and extension registration remain deterministic at startup.
- Windows grep and find prefer resolved `.exe` binaries for ripgrep and fd. They use argument arrays without a shell; the concurrent TypeScript implementation remains the offline or unavailable-tool fallback.
- Successful managed-tool and shell resolution is cached against the current `PATH`; cached absolute paths are revalidated before reuse. Concurrent tool downloads share one promise.
- Footer usage, context, and session-name scans are cached by the append-only session leaf, so input and streaming renders reuse O(1) statistics until the session changes.
- Consecutive parallel tools run as a shared group. A sequential tool is an exclusive ordered barrier; later shared work starts only after it completes.
- Model-runtime creation and resource discovery overlap. Immediate model requests may preconnect a reusable TCP/TLS socket when no proxy is configured.

## Compatibility and failure behavior

Dynamic loading is limited to bootstrap and optional-feature boundaries. Extension activation order, tool-result order, provider registration order, and command behavior remain deterministic. Native search falls back without requiring a manual tool install. Preconnect is best-effort, skips proxy and offline paths, sends no HTTP request, expires after 30 seconds, and never blocks the model request.

## Verification

Focused tests cover bootstrap isolation, extension cache/order, Windows grep/find behavior, fallback traversal, shared/exclusive scheduling, timing parsing, and socket reuse. `npm run check` remains the required repository-wide static gate. Startup and search medians are recorded before and after the change.

| Windows benchmark | Before | After | Change |
| --- | ---: | ---: | ---: |
| Published Node `--version` | 1333 ms | 42.4 ms | 31.4x faster |
| Isolated Node RPC `get_state` | 1440 ms | 299.0 ms | 79% faster |
| Repository content search | 8045 ms | 51.2 ms | 157x faster |
| `*.ts` file search | 137 ms | 32.3 ms | 4.2x faster |
| Repeated `rg` resolution | 41.7-78.3 ms | 0.1-0.2 ms | over 200x faster |
| Repeated Git Bash resolution | 79.3-85.5 ms | 0.1 ms | over 700x faster |

The final RPC figure is the median of nine measured runs after two warmups on Windows with an isolated agent directory and offline mode. The sample range was 282.8-335.6 ms. CPU profiles confirmed that unconditional CommonJS parsing for `jiti`, `jsdom`, the MCP SDK, and the sandbox runtime was removed from the ready path.
