# ADR 0054: Publish the generated Pigo product from its owning repository

## Status

Accepted

## Implementation record

`pi-gogogo@0.84.1` was published to the public npm registry on 2026-08-13 through an
owner-authenticated, account-2FA-protected bootstrap release. No npm publish token was written to the
repository or GitHub. After propagation, the public-registry smoke test installed the exact version into
an empty temporary global prefix and executed the installed command shim, version check, and redacted
doctor checks. npm metadata reported `latest = 0.84.1`, `pigo -> dist/bundle/cli.js`, and the fork-owned
repository URL.

## Problem

`pi-gogogo` is a generated CLI-only product package rather than an npm workspace. The existing release workflow belongs to
`earendil-works/pi`, publishes that repository's scoped workspace packages, and is disabled in forks. Pigo's package metadata,
development branch, and public product repository instead belong to `d3f4w2/pi-Gogogo`.

A local `npm pack` and global tarball smoke test therefore did not prove that `npm install -g pi-gogogo` could ever become
public. Adding Pigo to the upstream package set would also be wrong: npm provenance and trusted-publisher identity would point
at a repository that does not own the product metadata.

## Decision

Keep the upstream workspace release and announcement flow unchanged. Add a separate `Publish Pigo` workflow that runs only in
`d3f4w2/pi-Gogogo`, on version tags or an explicit workflow dispatch. The workflow receives only read and OIDC identity-token
permissions and uses the protected `npm-publish` environment.

Because npm allows trusted-publisher configuration only after a package exists, fail early when the package is absent and no
one-time `NPM_PUBLISH_TOKEN` repository secret is available. The first workflow run may use that bootstrap token while still
generating provenance. Afterward, configure npm trusted publishing for `d3f4w2/pi-Gogogo`, workflow `publish-pigo.yml`, and
environment `npm-publish`, then revoke the bootstrap token. Later runs use the OIDC identity before token fallback.

Extend the idempotent publisher with `--pigo-only`. In that mode it derives the product version from the lockstep workspaces,
builds the reduced staging package, queries the exact npm version, validates `npm pack --dry-run`, skips a byte-version already
published, or publishes only `pi-gogogo` with public access, provenance, and lifecycle scripts disabled. It never attempts to
publish the upstream scoped workspaces.

Before publication, the product workflow performs an offline build, repository checks, the non-e2e full test script, and the
isolated local package smoke test. A tag must exactly match the generated package version.

After publication, wait for exact-version npm metadata and a reachable integrity-bound tarball. Install that registry package
into a temporary global prefix, validate its generated manifest and command shim, then execute the installed CLI's version and
redacted doctor checks. Workflow success therefore proves the documented public installation path, not merely upload success.

Resolve npm through the active Node runtime's `npm-cli.js` in local publication and release preflight scripts. This avoids the
Node 24 Windows `spawnSync("npm.cmd")` failure while retaining the normal executable fallback.

## Consequences

### Positive

- Pigo provenance, repository metadata, and GitHub workflow identity agree.
- The Pigo workflow cannot accidentally publish `@earendil-works/*` packages.
- Publication is retry-safe and proves a fresh registry installation works.
- Windows developers can run publication dry-runs and npm registration preflight reliably.

### Negative

- Initial package ownership must be established by an authenticated npm owner before a trusted-publisher record can be created. Version `0.84.1` established that ownership with account 2FA rather than a persisted publish token.
- The fork owns a product release workflow in addition to the inherited upstream release workflow.

### Neutral

- `pi-gogogo` remains absent from npm workspaces even though the generated product is public on npm. Its generated manifest takes the current coding-agent version.
- Upstream release announcements continue to describe only upstream public workspace packages.

## Alternatives considered

**Add Pigo to the upstream `publish-npm` job**

Rejected because the upstream repository does not match Pigo's package ownership or provenance identity.

**Convert `pi-gogogo` into another workspace**

Rejected because it would duplicate the coding-agent dependency graph and weaken the generated CLI-only file contract.

**Treat a successful `npm publish` process exit as completion**

Rejected because registry propagation, metadata, tarball availability, installation, or the command shim can still fail.
