# Pigo npm Installation and Release Record

**Goal:** Make the locally built release installable with one npm command and make `pigo` executable from any working directory on Windows, macOS, and Linux.

**Architecture:** Build an unscoped, CLI-only `pi-gogogo` product package from the exact bundle and runtime assets produced by `packages/coding-agent`, while keeping the upstream SDK workspace identity separate. Add a source-level package contract check for fast CI feedback and a release-artifact smoke test that installs the real tarball into an isolated global prefix, prepends that prefix to `PATH`, and invokes `pigo` from directories outside the repository. The smoke test must inspect only public diagnostic output and must never contact a model provider.

**Tech Stack:** Node.js ESM, npm pack/install, node:test, TypeScript build output, Windows `.cmd`/PowerShell shims, POSIX executable shims.

---

## Decision

The npm package name `pigo` is already occupied by an unrelated package. Pigo is therefore published as [`pi-gogogo`](https://www.npmjs.com/package/pi-gogogo), while its executable remains `pigo`. The existing `@earendil-works/pi-coding-agent` package belongs to an upstream scope and its published artifact still exposes `pi`, so this fork cannot truthfully present it as the Pigo install target.

Renaming every upstream workspace would create unnecessary SDK and dependency churn. A runtime wrapper around the upstream package would be worse: it would execute upstream code instead of this fork's code. Therefore the product artifact is assembled from this repository's already bundled CLI. It contains that bundle, its runtime assets, and only the external dependencies deliberately left out by esbuild. There is no forwarding process or second CLI package at runtime.

The public install contract is:

```bash
npm install -g --ignore-scripts pi-gogogo
pigo
```

The first publication was authenticated by the npm owner with account-level `auth-and-writes` 2FA because npm trusted publishing can only be configured after package ownership exists. `pi-gogogo@0.84.1` was published on 2026-08-13. Future releases use the repository-owned GitHub Actions OIDC path after the npm trusted-publisher record is configured.

## Success criteria

1. The generated product manifest exposes `pigo -> dist/bundle/cli.js`, points at the fork repository, and contains no SDK exports or upstream package identity.
2. The package contains no install lifecycle script requirement and works with `--ignore-scripts`.
3. A real tarball can be installed into an empty isolated global prefix.
4. With only that prefix added to `PATH`, these commands work outside the repository:
   - `pigo --version`
   - `pigo --help`
   - `pigo doctor --json`
   - `pigo --list-models`
5. The test covers a normal project directory, a directory containing spaces, and `C:\Windows\System32` on Windows.
6. The doctor JSON contains no environment map or credential value and System32 produces the expected warning.
7. Static checks, focused tests, and the repository non-E2E suite pass.

### Task 1: Add the product package builder and contract checker

**Files:**
- Create: `scripts/pigo-package.mjs`
- Create: `scripts/pigo-package.test.mjs`
- Modify: `package.json`

**Step 1: Write failing tests**

Test product manifest generation for the correct name, repository, `pigo` bin, exact external runtime dependencies, missing or legacy `pi` bins, lifecycle scripts, and required asset paths.

**Step 2: Run the test and verify failure**

Run:

```bash
node --test scripts/pigo-package.test.mjs
```

Expected: failure because the builder does not exist.

**Step 3: Implement the builder and checker**

Export pure manifest construction and validation functions for tests. The executable path copies only the built CLI JavaScript, the explicit image-resize worker, themes, interactive assets, HTML export runtime, Windows sandbox helper, docs, README, changelog, and license to `.artifacts/pi-gogogo/package`. It deliberately excludes SDK declarations, source maps, examples, and internal workspace package identities. Add source contract validation to the root `npm run check` chain.

**Step 4: Verify**

Run the focused node test and `npm run check:pigo-package`.

### Task 2: Add a real installed-tarball smoke test

**Files:**
- Create: `scripts/smoke-pigo-package.mjs`
- Create: `scripts/smoke-pigo-package.test.mjs`
- Modify: `package.json`

**Step 1: Write failing helper tests**

Cover platform-specific global npm bin resolution, PATH augmentation, JSON output validation, and System32 warning validation.

**Step 2: Implement the smoke runner**

The runner must:

1. Refuse to run if `packages/coding-agent/dist/bundle/cli.js` is absent.
2. Create all artifacts under an OS-generated temporary directory.
3. Build the product staging directory, then run `npm pack --ignore-scripts` there.
4. Inspect the packed metadata for the expected `pi-gogogo` identity and `pigo` bin.
5. Run `npm install -g --prefix <temp> --ignore-scripts <tarball>`.
6. Add the isolated global bin directory to `PATH` and invoke `pigo` by name.
7. Validate version, help, doctor JSON, redaction shape, and System32 behavior.
8. Remove only its own generated temporary directory in `finally`.

**Step 3: Verify**

Run the helper tests before building. After the package build, run `npm run smoke:pigo-package` from the repository root.

### Task 3: Build the release artifact

**Files:**
- Generated output only under package `dist` directories and `.artifacts/pi-gogogo`.

**Step 1: Build packages in dependency order**

Run the repository offline build so the CLI bundle and internal packages are produced without provider traffic.

```bash
npm run build:offline
```

**Step 2: Inspect the tarball**

Run `npm pack --dry-run --ignore-scripts --json` in `.artifacts/pi-gogogo/package`. Assert that `dist/bundle/cli.js`, split chunks, `dist/bundle/image-resize-worker.js`, required runtime assets, the product README, and license are present. Assert that SDK declarations, examples, and source maps are absent.

### Task 4: Verify installation outside the repository

**Files:**
- No repository file changes.

Run:

```bash
npm run smoke:pigo-package
```

Expected: all commands resolve through the isolated global prefix. No command may resolve workspace source or the user's existing global Pigo installation.

### Task 5: Complete repository verification

**Files:**
- Modify only implementation or test files needed to fix discovered failures.

Run:

```bash
npm run check
node --test scripts/pigo-package.test.mjs scripts/smoke-pigo-package.test.mjs
./test.sh
git diff --check
```

Do not run provider E2E tests and do not make paid model requests.

### Task 6: Update product documentation

**Files:**
- Modify: `README.md`
- Modify: `packages/coding-agent/README.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

Keep the install command visible before technical detail. Document `pigo doctor` as the immediate post-install verification. Explain the product in terms of daily repository work, governed execution, saved sessions, and extensibility; keep release internals out of the primary product flow.

### Task 7: Add the fork release workflow

**Files:**
- Create: `.github/workflows/publish-pigo.yml`
- Modify: `.github/workflows/build-binaries.yml`
- Modify: `package.json`

The Pigo workflow verifies the tag version, builds offline, runs checks and provider-free tests on Linux and Windows, installs the real tarball in an isolated global prefix, publishes the same verified tarball through npm trusted publishing with provenance, and attaches the tarball plus SHA-256 checksum to the GitHub release. The inherited upstream npm/pi.dev publication jobs are restricted to `earendil-works/pi`, so a fork tag cannot publish upstream package identities or announce itself on pi.dev.

The workflow is idempotent for an npm version that already exists. It still requires the `npm-publish` GitHub environment and an npm trusted-publisher record for `d3f4w2/pi-Gogogo`. Package ownership now exists through the public `0.84.1` release, so that trusted-publisher record can be configured without retaining a long-lived npm publish token.

## Public release evidence

`pi-gogogo@0.84.1` was published to the public npm registry on 2026-08-13. After registry
propagation, `scripts/smoke-published-pigo.mjs --version 0.84.1` installed the exact public version into
an empty temporary prefix and verified the generated product manifest, the platform command shim,
`pigo --version`, and redacted doctor output. Registry metadata independently reported:

- `latest = 0.84.1`
- `pigo -> dist/bundle/cli.js`
- `git+https://github.com/d3f4w2/pi-Gogogo.git`

The initial owner-authenticated publication did not persist a publish token in the repository or GitHub.
The remaining release-operations step is to bind npm trusted publishing to repository
`d3f4w2/pi-Gogogo`, workflow `publish-pigo.yml`, and environment `npm-publish`; subsequent versioned
releases can then use short-lived GitHub OIDC identity and provenance instead of a reusable npm secret.
