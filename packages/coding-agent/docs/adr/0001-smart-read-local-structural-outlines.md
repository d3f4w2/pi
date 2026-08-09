# ADR-0001: Use Local Structural Outlines for Long Code Reads

## Status

Accepted

## Context

The current `read` tool returns up to the normal line/byte limit even when a model initially needs only a file map. Reliable-edit anchors improve mutation accuracy but add a small prefix to every returned line, making broad reads more expensive. The agent needs high whole-file recall without paying for every implementation line.

Oh My Pi uses a native tree-sitter summarizer. This repository already includes `@ast-grep/napi` for structural search, but only its bundled JavaScript, TypeScript, TSX, HTML, and CSS grammars are available. Python and Go language servers may exist, but starting them just to read a file would add latency and failure modes.

## Decision

Use an automatic local structural outline for long supported code files:

- use `@ast-grep/napi` for bundled grammars;
- use bounded lexical declaration extraction for Python and Go;
- preserve exact line numbers and line hashes on visible lines;
- make explicit ranges verbatim;
- cache by content revision;
- require meaningful estimated output reduction in automatic mode and bound individual displayed lines;
- fail open to the existing verbatim reader.

## Consequences

### Positive

- Large initial reads use substantially fewer tokens.
- The model sees declarations distributed across the whole file, not only its first chunk.
- Follow-up range reads and anchored edits remain exact.
- No new dependency, service, process, credential, or index is required.
- Failures do not block ordinary reads.

### Negative

- An outline can omit implementation details that later require a focused read.
- Python and Go extraction is less precise than a full parser.
- Anchored outline formatting adds implementation complexity to `read`.
- Content-based caching consumes bounded process memory.

### Neutral

- Short files and explicit ranges behave as before, apart from existing reliable-edit anchors.
- Users and SDK callers can force `full` or `outline` mode.

## Alternatives Considered

### Model-generated summaries

Rejected because they add network latency, token cost, nondeterminism, credential dependence, and another failure path to a basic filesystem operation.

### Regex-only summaries for every language

Rejected as the primary method because exports, overloads, nested classes, multi-line signatures, JSX, and TypeScript declarations are not reliably recognized by regex. Kept only as a bounded fallback for Python and Go.

### Always return complete files

Rejected because it maximizes recall per call but wastes context on large implementations and makes the new line anchors more expensive.

### Start LSP and request document symbols

Rejected for automatic reads because language-server startup can take seconds, servers may be missing for Python/Go, and document symbols do not include enough exact source context. LSP remains available when semantic symbol information is explicitly needed.

## References

- [Smart Read Architecture](../smart-read-architecture.md)
- [Reliable Edit Architecture](../reliable-edit-architecture.md)
- [Oh My Pi repository](https://github.com/can1357/oh-my-pi)
