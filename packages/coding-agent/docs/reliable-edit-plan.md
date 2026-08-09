# Reliable Edit Implementation Plan

## 1. Lock the protocol with tests

- Test stable line and file hashes.
- Test anchored read output with offset and limit.
- Test that compact instruction/resource reads remain plain.
- Test single-line, range, moved-unique-anchor, duplicate-anchor, stale-revision, overlap, no-op, CRLF, and BOM edits.
- Test that validation failures perform no write.
- Test atomic replacement cleanup on failure.

## 2. Add the shared anchor codec

- Create `src/core/tools/file-anchors.ts`.
- Keep hashing, parsing, formatting, and range resolution independent of TUI rendering.
- Use erasable TypeScript and Node built-ins only.

## 3. Upgrade `read`

- Add the revision header and line anchors to ordinary text output.
- Preserve original source line numbers for partial reads.
- Keep images and compact instruction/resource reads unchanged.
- Expose the revision in result details for SDK consumers.

## 4. Upgrade `edit`

- Extend the schema with anchored edit entries and `baseHash`.
- Validate one edit mode per entry.
- Resolve and validate all ranges against the same current snapshot.
- Reuse the existing diff, line-ending, BOM, and mutation-queue logic.

## 5. Add atomic local replacement

- Write to a unique sibling temporary file.
- Rename over the target only after the complete write succeeds.
- Clean up the temporary file on every pre-commit failure.
- Keep custom operations pluggable.

## 6. Verify the closed loop

- Run the new focused tests.
- Run existing edit/render tests.
- Create a temporary project, read anchors, edit a range, then verify the diff and final file.
- Run `npm run check`.

## 7. Document and ship

- Add user-facing examples to the tool documentation.
- Add the change under `CHANGELOG.md` `[Unreleased]`.
- Commit only reliable-edit files and push after verification.

