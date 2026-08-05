# Publishing prime-linc to npm

The public package is **`@casemark/prime-linc`**. It is a single standalone
package even though the source is a workspace monorepo: the customized
`@earendil-works/pi-*` code is bundled, while native/interop-sensitive runtime
dependencies remain ordinary npm dependencies. Release builds compile the committed
model catalog rather than refetching mutable provider metadata.

The package exposes three equivalent commands:

```text
prime-linc   # canonical
linc         # Bastion / CaseMark compatibility
pi           # upstream compatibility
```

It also includes `skills/`, `examples/`, and linked documentation. The build
bundles both the customized JavaScript workspaces and their public TypeScript
declarations. `scripts/publish.mjs` packs and installs the staged tarball before
every publish, then verifies the version, JavaScript and TypeScript imports, all
three binaries, the websearch skill, documentation, and the subagent extension
example.

## Normal release

1. Create a reviewed PR that updates changelogs and bumps all workspace versions
   in lockstep (`npm run version:patch`, `version:minor`, or `version:major`).
2. Merge it to `main`.
3. Run the **Release npm package** GitHub Actions workflow.

The workflow tags the reviewed `main` commit as `v<version>` and dispatches the
separate **npm Publish** workflow. A human-pushed `v*` tag reaches that same
single workflow identity. The publisher refuses tag/package-version or
integrity mismatches, so recovery reruns are safe.

## One-time bootstrap for the first package version

npm trusted publishing is configured from an existing package's settings, so
the first creation of `@casemark/prime-linc` needs temporary token auth:

1. Create a granular npm token with publish access to the `@casemark` scope.
2. Add it as `NPM_TOKEN` in the repository's **npm-publish** GitHub environment.
3. Run the release workflow once.
4. In the new package's npm settings, add a trusted publisher:
   - Provider: **GitHub Actions**
   - Organization: **CaseMark**
   - Repository: **prime-linc**
   - Workflow filename: **npm-publish.yml**
   - Environment: **npm-publish**
   - Allowed action: **npm publish**
5. Delete `NPM_TOKEN` from the GitHub environment.

All later publishes use short-lived GitHub OIDC credentials and npm provenance;
there is no long-lived registry secret to rotate. The workflow builds, tests,
packs, and smoke-tests without registry credentials, uploads the exact tarball,
then an environment-gated job with `id-token: write` publishes that artifact
without checking out or executing repository code. The GitHub environment
requires approval and only accepts deployments from `main` or `v*` tags.

## Local validation

```bash
npm ci
npm run build
npm run check
npm test
npm run publish:dry
```

The dry run makes the real tarball and performs the clean-install smoke without
publishing. Verify a release with:

```bash
npm view @casemark/prime-linc version
npm install -g @casemark/prime-linc
prime-linc --version
```

## Recovery

The **npm Publish** workflow supports manual dispatch from `main` with an
existing `tag`. The tag must resolve to reviewed `main` history. Use this only
to retry an already-reviewed release. Stable versions publish under `latest`;
a named prerelease such as `1.2.3-beta.1` publishes under its first prerelease
label (`beta`) and never replaces `latest`. npm versions are immutable, so fix
a bad release with a new patch version—never by reusing a tag.
