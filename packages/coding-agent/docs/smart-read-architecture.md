# Smart Read Architecture

## Requirements

### Functional

- Keep short files verbatim.
- Automatically return a structural outline for long supported code files.
- Preserve exact source line numbers and reliable-edit anchors for every visible source line.
- Let callers force `auto`, `full`, or `outline` behavior.
- Treat an explicit `offset` or `limit` as a request for verbatim focused content.
- Support TypeScript, TSX, JavaScript, HTML, and CSS through the bundled AST parser.
- Support Python and Go through bounded declaration extraction.
- Show omitted ranges with a directly usable `offset` and `limit` continuation.
- Fall back to the existing verbatim read when summarization is unsupported or fails.

### Non-functional

- No model call, network request, child process, installation, or background index.
- No more than one megabyte of source is parsed for an outline.
- Outline generation has a fixed line budget and bounded cache.
- Auto mode keeps the verbatim result when the estimated outline would retain 75% or more of the source characters.
- Individual outline lines are capped at 500 displayed characters and point to an exact focused read for expansion.
- The failure path must be faster and safer than failing the read.
- Output must remain deterministic for the same content.
- Instruction resources such as `AGENTS.md` and `SKILL.md` remain verbatim.

## Data flow

```text
read(path, mode?, offset?, limit?)
  -> read bytes once
  -> classify resource / image / code
  -> explicit range? ---------------------> verbatim anchored slice
  -> short or mode=full? -----------------> verbatim anchored content
  -> supported long code?
       -> cache hit ----------------------> structural outline
       -> AST parser (TS/JS/TSX/HTML/CSS)
       -> lexical declarations (Python/Go)
       -> parser failure -----------------> verbatim anchored content
  -> format revision header
  -> format visible source lines with line#hash anchors
  -> insert compact omitted-range instructions
```

## Output protocol

```text
¶src/store.ts#d9F2sL0pQa
[Outline: 842 lines, 73 source lines shown. Use mode="full" or offset/limit to expand.]
1#6D8fAq|import { readFile } from "node:fs/promises";
2#dT2pLm|import path from "node:path";
[... lines 3-18 omitted; use offset=3 limit=16 ...]
19#f9Qw3A|export interface StoreOptions {
20#P0m2Vs|  root: string;
24#6Gv4Rx|}
[... lines 25-44 omitted; use offset=25 limit=20 ...]
45#nA7k1D|export class Store {
51#cV9pQ2|  async load(id: string): Promise<Item> {
```

Only source lines carry anchors. Outline metadata and omission instructions cannot be used as edit targets. A focused follow-up read returns contiguous source with anchors and the same file revision, completing the read-to-edit loop.

## Structural selection

The outline builder assigns priorities instead of dumping every AST node:

1. top-level declaration and statement starts;
2. import/export declarations;
3. class/interface members and method signatures;
4. multi-line declaration signature continuations;
5. declaration closing lines;
6. top-level comments.

When the candidate set exceeds the output budget, the highest-priority lines win and are then restored to source order. Large gaps become omission instructions; small gaps remain visible through the original line-number jump without spending more tokens on metadata. This preserves whole-file recall better than returning only the beginning of the file.

Python and Go use line-oriented declaration recognition because the bundled AST package does not ship those grammars. It selects imports, decorators, constants, type declarations, functions, and methods. Unsupported languages remain verbatim.

## Cache

The cache key is `language + normalized file revision`; it does not depend on timestamps. This makes it safe for custom read backends and automatically invalidates when content changes. The cache stores at most 64 outline plans and evicts the least recently used entry.

## Failure handling

- Parser unavailable or syntax invalid: return verbatim content.
- File over the parser byte limit: return verbatim truncated content.
- Outline has too little compression: return verbatim content.
- A declaration line exceeds the display cap: keep its full-content anchor, show a bounded prefix, and include an exact `offset`/`limit` expansion.
- Empty or generated-looking structure: return verbatim content.
- Abort before formatting: reject as the existing read does.
- Cache error: ignore the cache and continue.

No summarizer error is exposed as a failed `read` call.

## Security

- Parsing is local and read-only.
- The outline never evaluates source code.
- File paths continue through existing path resolution and access checks.
- The parser byte cap limits hostile or accidentally huge inputs.
- Cached entries contain source excerpts already returned by `read`; they are process-local and bounded.

## Verification

- Unit tests for AST and lexical selection.
- Integration tests for `auto`, `full`, `outline`, explicit ranges, unsupported files, parser failure, and compact resources.
- Snapshot-independent assertions on line coverage and omission instructions.
- A benchmark comparing output characters and elapsed time on representative repository files.
- A real outline -> focused read -> anchored edit workflow.
