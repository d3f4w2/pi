# External Information Plane Hardening Proof

## Objective

Prove that the audited external-information and cache fixes change observable behavior without using a paid provider or a real API key. The proof covers official-source verification, fallback count, resource-cache concurrency, structured-output size, read metadata, Browser 2 security/capabilities, and prompt-cache privacy.

## Environment

- Date: 2026-08-10
- Platform: Windows, repository workspace
- Network fixtures: injected deterministic transports and a loopback HTTP server
- Browser fixture: an installed Chromium-family browser launched with an isolated temporary profile
- Paid model/API calls: zero
- Real API keys: zero

## Procedure

Run the external resource and research proof:

```text
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/external-resources.test.ts test/research-engine-2.test.ts test/external-resource-read-grep.test.ts test/unified-read.test.ts test/write-tool-diff.test.ts --disableConsoleIntercept
```

Run Browser 2 against the local server and installed browser:

```text
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/browser-cdp.test.ts test/browser-extension.test.ts test/browser-2-integration.test.ts --disableConsoleIntercept
```

Run prompt-cache semantics and privacy regressions:

```text
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/prompt-cache-optimizer.test.ts test/prompt-cache-runtime.test.ts

cd packages/ai
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/openai-responses-state.test.ts
```

## Fixed ten-question research set

| Query | Expected official family |
| --- | --- |
| `github openai/openai-node pull 123` | GitHub |
| `gitlab gitlab-org/gitlab` | GitLab |
| `npm package @types/node` | npm |
| `pypi package requests` | PyPI |
| `crate serde` | crates.io |
| `go package golang.org/x/net` | Go Packages |
| `arxiv 2401.01234` | arXiv |
| `OSV GHSA-xxxx-yyyy-zzzz` | OSV |
| `CVE-2024-3094` | NVD |
| `CISA KEV CVE-2024-3094` | CISA KEV |

Each case invokes a deterministic verifier fixture. Production uses the same verifier contract with the structured adapter. Separate tests exercise adapter success, API-to-page fallback, cache, malicious HTML removal, and missing-source fallback. Therefore classification alone cannot satisfy the metric.

## Recorded results

### Research and resource plane

| Metric | Result |
| --- | ---: |
| Verified official-source first hit | 10/10, 100% |
| Mean model-visible tool calls | 1.0 |
| Verified fixture p50 / p95 | 0.130 / 1.859 ms |
| Mean estimated model-input tokens | 132.2 |
| Fixed generic eight-result baseline | 428 estimated tokens |
| Estimated input-token reduction | 69.11% |
| Ten-read resource cache hit rate | 90% |
| Upstream fetches for ten reads | 1 |
| Cold / mean-hit latency | 30.546 / 0.019 ms |
| Mean-hit speedup | about 1,598x |
| Concurrent same-key logical reads | 3 |
| Concurrent same-key upstream fetches | 1 |
| Concurrent same-key cache accounting | 1 miss, 2 hits, 1 byte, 0 evictions |
| Focused assertions | 46/46 passed |

The 90% hit rate is the mathematically expected result for one cold read followed by nine reads. Once warm, the measured sequence is 9/9 hits. The same-key concurrency case proves that two simultaneous cold callers share one fill rather than racing two writes.

The single-downgrade regression forces both official validation and Brave to fail. DuckDuckGo is not called after that second failure. For an unclassified query, Brave may still downgrade once to DuckDuckGo.

Registry and code-host fixtures include deliberately noisy historical versions or patch bodies. The rendered result keeps the current useful fields and omits the noise. External `read` with an offset or limit reports `truncated=true`; `write` rejects resource schemes before filesystem resolution.

### Browser 2 real run

| Metric | Result |
| --- | ---: |
| Capability groups exercised | 18 |
| End-to-end elapsed | 1,946.765 ms |
| Stale snapshot reference rejected | yes |
| Outside-workspace upload rejected | yes |
| Viewport screenshot | 2,150 bytes |
| Full-page screenshot | 2,150 bytes |
| Focused assertions | 14/14 passed |

The real browser run covers tabs, navigation/history/reload, waits, hover/press/select, upload, download records, page/network failures, both screenshot modes, and stale references. Unit regressions additionally reject trailing-dot metadata names, private IPv6, private/mixed DNS, unauthorized loopback origins, and unauthorized WebSocket origins. A 5 MB CDP screenshot envelope succeeds, while decoded screenshots remain subject to the 20 MB output cap.

### Prompt-cache semantics and privacy

| Suite | Result |
| --- | ---: |
| Coding-agent optimizer/runtime | 18/18 passed |
| AI Responses continuation state | 7/7 passed |

An extension-owned `prompt_cache_key` no longer bypasses developer-context normalization. Runtime inspection proves that prompt, output, and tool text are absent from retained cache state; exact-prefix decisions use per-item SHA-256 digests and byte counts.

## Interpretation and limits

- The 100% official result applies to the ten high-confidence structured queries, not arbitrary natural-language questions.
- The research latency is local routing plus verifier-fixture time, not public-internet latency.
- Token figures use UTF-8 bytes divided by four; provider tokenization and billing can differ.
- The browser run is real Chromium behavior against a local deterministic site. It intentionally does not access user cookies or a paid external service.
- Request-time DNS validation blocks direct private/mixed answers, but direct CDP cannot pin Chromium's later DNS connection to the exact validated answer. A narrow DNS-rebinding race remains a documented residual risk.
