# Publishing prime-linc releases

prime-linc is distributed as an npm-compatible tarball attached to an immutable
GitHub Release. The public repository is MIT licensed, so the CLI and SDK do not
need a separate registry publication or npm credentials. npm remains the local
installer for the tarball and its ordinary runtime dependencies.

The release artifact is a single standalone package named
`@casemark/prime-linc`. The customized `@earendil-works/pi-*` code and public
TypeScript declarations are bundled, while native/interop-sensitive runtime
dependencies remain install-time dependencies. Release builds compile the
committed model catalog rather than refetching mutable provider metadata.

The package exposes three equivalent commands:

```text
prime-linc   # canonical
linc         # Bastion / CaseMark compatibility
pi           # upstream compatibility
```

It also includes the disk-loaded themes, templates, Python runtime, skills,
examples, documentation, and images required at runtime. `scripts/publish.mjs`
stages, packs, clean-installs, and smoke-tests the exact tarball before release.

## Install

Install the latest release with Node.js 22.8 or newer:

```bash
npm install -g https://github.com/CaseMark/prime-linc/releases/latest/download/prime-linc.tgz
```

Production consumers must pin both the tag and checksum:

```bash
VERSION=v0.7.0
curl -fL -o prime-linc.tgz "https://github.com/CaseMark/prime-linc/releases/download/${VERSION}/prime-linc.tgz"
curl -fL -o release.json "https://github.com/CaseMark/prime-linc/releases/download/${VERSION}/release.json"
curl -fL -o SHA256SUMS "https://github.com/CaseMark/prime-linc/releases/download/${VERSION}/SHA256SUMS"
sha256sum -c SHA256SUMS
npm install -g ./prime-linc.tgz
```

Bastion images must use the versioned URL and a reviewed SHA-256 value rather
than the moving `latest` URL.

## Normal release

1. Create a reviewed PR that updates changelogs and bumps all workspace versions
   in lockstep (`npm run version:patch`, `version:minor`, or `version:major`).
2. Merge it to `main`.
3. Run the **Release prime-linc** GitHub Actions workflow from `main`.

The workflow tags the reviewed commit as `v<version>` and dispatches the
separate **GitHub Release** workflow. The publisher rejects tag/version
mismatches and tags outside reviewed `main` history.

The release workflow builds, checks, tests, packs, and clean-install smoke-tests
without write credentials. It passes the tarball, `release.json`, and
`SHA256SUMS` through a GitHub Actions artifact to a separate environment-gated
job that does not check out or execute repository code. That job creates a draft release, verifies or
uploads the three exact assets, then publishes it. Repository release immutability
locks the tag and assets and produces a GitHub release attestation. The
`Protect release tags` ruleset also blocks deletion or movement of `v*` tags.

## Local validation

```bash
npm ci
npm run build
npm run check
npm test
npm run publish:dry
```

The dry run creates the real package and runs the clean-install smoke without
publishing. Verify a downloaded release with:

```bash
gh release verify v0.7.0 --repo CaseMark/prime-linc
gh release verify-asset v0.7.0 prime-linc.tgz --repo CaseMark/prime-linc
```

## Recovery

The **GitHub Release** workflow supports manual dispatch from `main` with an
existing `tag`. It rebuilds that tag, then either completes an interrupted draft
or verifies an already-published release byte for byte. It never overwrites a
mismatched asset. Published releases and their tags are immutable, so fix a bad
release with a new patch version rather than reusing a tag.
