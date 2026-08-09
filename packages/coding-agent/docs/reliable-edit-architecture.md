# Reliable Edit Architecture

## Goal

Make the existing `read` and `edit` tools land code changes on the first attempt while preventing stale or partial writes.

The design must:

- target the exact lines the model read without copying a large `oldText` block;
- detect files that changed between reading and editing;
- validate every edit before changing the file;
- preserve BOM and line endings;
- keep exact-text edits working for callers that do not use anchors;
- add no background process, model call, or external index.

## Current problem

The current edit flow is:

```text
read plain text
  -> model copies oldText
  -> edit searches for a unique text block
  -> all replacements are validated
  -> file is written once
```

It already rejects overlapping edits and validates a multi-edit request before writing. Its weak point is the address: copied text is large, whitespace-sensitive, and becomes stale easily.

## New flow

```text
read code file
  -> emit file revision + line anchors
  -> model returns anchor ranges + replacement text
  -> edit reads the current file inside the mutation queue
  -> validate revision, anchors, ordering, overlap, and no-op
  -> build the complete next file in memory
  -> atomically replace the file
  -> return a compact diff
```

Example read result:

```text
¶src/user.ts#nV3sD8qL2p
10#u8L2Qp|export function loadUser(id: string) {
11#P4c1Mx|  return users.get(id);
12#0aN7Ke|}
```

Example anchored edit:

```json
{
  "path": "src/user.ts",
  "baseHash": "nV3sD8qL2p",
  "edits": [
    {
      "startAnchor": "10#u8L2Qp",
      "endAnchor": "12#0aN7Ke",
      "newText": "export function loadUser(id: string): User | undefined {\n  return users.get(id);\n}"
    }
  ]
}
```

## Components

### Anchor codec

A small shared module owns:

- LF normalization;
- a short URL-safe content hash for each line;
- a longer file revision hash;
- formatting and parsing `line#hash` anchors;
- formatting anchored read output.

The hash is an address and stale-data guard, not a security boundary.

### Read integration

Normal text reads include one revision header and prefix every returned line with its original line number and content hash. The continuation notice remains plain metadata and is not editable content.

Images are unchanged. Pi documentation, context resources, and `SKILL.md` remain plain text because they are normally consumed as instructions rather than edited, avoiding needless token overhead.

### Edit integration

Each entry in `edits` uses exactly one mode:

- anchored: `startAnchor`, optional `endAnchor`, and `newText`;
- exact text: `oldText` and `newText`.

Anchored edits are preferred. Exact-text mode remains for SDK callers, remote filesystems, and text obtained outside `read`.

Anchors are resolved against the current normalized file. The stated line is checked first. If it moved, the hash may relocate only when it identifies one unambiguous line. Duplicate or missing anchors fail closed.

`baseHash` validates the read snapshot. A mismatch rejects the request before mutation. The error tells the model to reread a focused range; it does not dump the whole file.

### Atomic write

For the local filesystem, the complete output is written to a temporary sibling file and renamed over the target. The temporary file uses the target directory so the rename stays on one filesystem. On failure, the original remains unchanged and the temporary file is cleaned up.

Custom edit backends may provide an atomic replacement operation. Existing backends without it use their current single-write behavior and are explicitly marked as not crash-atomic.

## Failure rules

The edit is rejected without writing when:

- the file revision differs;
- an anchor is malformed, missing, or ambiguous;
- a range is reversed;
- two ranges overlap;
- anchored and exact fields are mixed in one edit;
- replacement output is identical;
- access, read, temporary write, or rename fails;
- the operation is aborted before commit.

After rename succeeds, cancellation no longer reports the edit as aborted because the mutation has committed.

## Token and latency impact

- Read adds a compact prefix per code line and one header.
- Edit output becomes smaller because the model sends anchors instead of copied old blocks.
- Hashing is linear in the selected file and uses no process spawn or network call.
- One local temporary write and one rename replace the previous direct write.
- No work happens unless `read` or `edit` is called.

## Key decisions

### ADR-1: Upgrade existing tools instead of adding `hash_edit`

One tool surface is easier for models and users. A second editing tool would duplicate permissions, rendering, LSP hooks, and documentation.

### ADR-2: Use line-content anchors plus a file revision

Line numbers alone silently target the wrong code after movement. Whole-file hashes alone detect staleness but do not address a range. Combining both provides precise addressing and explicit snapshot validation.

### ADR-3: Fail closed on stale revisions

Automatic three-way recovery is valuable but can merge the wrong intent. This version prioritizes guaranteed safety. Snapshot-based stale recovery can be added later behind the same protocol without changing the tool name.

### ADR-4: Preserve exact-text mode

Not every caller receives anchored read output. Exact-text editing remains a useful fallback, while the prompt teaches the model to prefer anchors.

### ADR-5: Commit with sibling-temp rename

Validation-before-write prevents logical partial edits; rename-based replacement also prevents a process or filesystem failure from leaving a half-written file.

## Boundaries

This milestone does not add multi-file transactions, snapshot persistence, automatic conflict merging, AST rewrites, or a new UI approval step.

