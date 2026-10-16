# Releasing vtc

Owner: the cli+binary team (spine AD-26; spec §4.4; decisions D-az, H-2, H-11 and H-16).
Releases are GitHub Releases in the private bason-labs/bs-vtc repository (H-16, spine §5 reading
240): unsigned binaries, `SHA256SUMS`, the installer and formula as plain assets, and release
notes taken from `CHANGELOG.md`. Nothing is published anywhere else: no Homebrew tap and no
plugin marketplace. Only the Lead tags and creates a release; no team does.

## Later, if needed: signing and notarization

Releases ship unsigned, with SHA-256 checksums (H-2). An Apple Developer ID is needed only once
other people download VTC (H-11, 2026-10-15; spine §5 reading 235), so there is none for now.
The todo stays here for that day: **sign + notarize once the owner has an Apple Developer ID**,
and revisit it before any release leaves the private repository.

The `sign-macos` job's body is a placeholder, not a working recipe: a runner starts with no
certificate and no notary profile. To switch it on: store the Developer ID certificate (a base64
`.p12` and its password) and the notary credentials (an App Store Connect API key, or Apple ID,
team ID and app-specific password) as repository secrets; add steps before `codesign` that
create a temporary keychain, import the certificate into it (`security create-keychain`,
`security import`, `security set-key-partition-list`) and save the notary credentials into it
with `xcrun notarytool store-credentials <profile> --keychain <that keychain>`, plus a final step
that deletes the keychain; then remove `if: ${{ false }}` from the job in
`.github/workflows/release.yml`, and check under test that `macos/entitlements.plist` (only
`allow-jit` and `allow-unsigned-executable-memory`) is enough; add a key only when a signed smoke
test needs it. Signing runs before the checksums, so `SHA256SUMS` always covers the signed bytes,
and the release notes stop saying the binaries are unsigned (`release-notes.ts --signed`).

## Not part of a private release (H-16)

- Pushing the rendered `vtc.rb` to a tap repository (`<owner>/homebrew-<name>`,
  `Formula/vtc.rb`).
- Publishing the generated plugins to the marketplace release branch (AD-16 rule 5).

## Cutting a release (the Lead)

1. Add a `## v<version> (<date>)` section to `CHANGELOG.md` (move the `Unreleased` items into
   it) and set `VERSION` in `packages/cli/src/version.ts` and `packages/cli/package.json`.
2. Preview the notes: `bun packages/cli/scripts/release-notes.ts --version <version> --repo
bason-labs/bs-vtc --out <scratch>/notes.md`. It fails when `CHANGELOG.md` has no section for
   the version.
3. Tag `v<version>` on `build/foundation` and push the tag. The workflow below builds, checks and
   publishes the release with those notes.
4. A release whose notes were written by hand (or by an older workflow, as at the `v0.1.0` tag)
   gets the CHANGELOG notes with `gh release edit v<version> --notes-file <scratch>/notes.md`;
   immutable releases lock the tag and the assets, not the notes.

## What a release is

`.github/workflows/release.yml` runs on a `v*` tag (and as a dry run from `workflow_dispatch`):

1. **verify**: the tag must equal `VERSION` in `packages/cli/src/version.ts`, and
   `CHANGELOG.md` must have that version's section; then `pnpm install --frozen-lockfile` and
   `pnpm verify` with Bun 1.4.3 installed.
2. **cross-compile**: `pnpm build`, then `scripts/build-binary.ts` once per target
   (darwin-arm64/x64, linux-x64/arm64, windows-x64).
3. **smoke**: each binary on a native runner: `vtc --version` and an MCP `initialize` through
   `vtc engine --mcp` outside any repository.
4. **sign-macos**: skipped (later, if needed; see above).
5. **package**: `vtc-<version>-<os>-<arch>.tar.gz` (`.zip` for Windows), the rendered Homebrew
   formula `vtc.rb` and installer `install.sh`, and `SHA256SUMS` over all of them (sorted, LF,
   `sha256sum -c` compatible), checked with `sha256sum -c` before upload. Then the release
   notes (`scripts/release-notes.ts`): the version's `CHANGELOG.md` section, how to verify a
   download, that the binaries are unsigned, and the upgrade note. They are uploaded apart from
   the assets, so `SHA256SUMS` lists only what users download.
6. **publish** (tags only): attests every asset with GitHub artifact attestations when the
   repository variable `VTC_ATTEST` is `true` (attestations need a public repository or GitHub
   Enterprise Cloud, so the private repository on GitHub Free skips them), creates a draft
   release with the assets and the CHANGELOG notes, then publishes it. With immutable releases switched on in the
   repository settings, the published tag and assets cannot change.

Every `uses:` is pinned to a full commit SHA; the workflow token is `contents: read` everywhere
except the publish job (`contents: write`, `id-token: write`, `attestations: write`).

## Installing and verifying

**Upgrading** (D-bo, spine §5 reading 169): the Claude Code settings `vtc install` writes change
between releases (wave 3 added the session sandbox's write denies), so after upgrading, in each
repo where you use VTC with Claude Code, re-run `vtc install --host claude-code`. The release
notes, `install.sh` (when it replaces an existing `vtc`) and the Homebrew caveats say so.

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/<owner>/<repo>/releases/download/v<version>/install.sh | sh
```

`install.sh` (POSIX sh) runs nothing until it is fully downloaded, verifies the archive against
`SHA256SUMS` with `sha256sum` or `shasum -a 256` and stops when neither exists, installs into
`$HOME/.local/bin` (or `VTC_INSTALL_DIR`) with an atomic rename, and never uses sudo or edits a
shell rc file. `VTC_VERIFY_ATTESTATION=1` also runs `gh attestation verify`.

A checksum shows a download is intact, not who built it. To check provenance yourself:

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify vtc-<version>-<os>-<arch>.tar.gz -R <owner>/<repo>
gh release verify v<version> -R <owner>/<repo>
```

An unsigned macOS binary downloaded with a browser is quarantined; the installer and Homebrew
download with `curl`, which sets no quarantine flag.

## Files

| File                                   | What it is                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `install.sh`                           | The installer; the release fills in its repository and version                        |
| `homebrew/vtc.rb.tmpl`                 | The formula template, one URL and SHA-256 per macOS/Linux platform                    |
| `macos/entitlements.plist`             | Hardened-runtime entitlements for signing (unused until H-2)                          |
| `../packages/cli/scripts/release-*.ts` | Checksums, rendering and release notes, tested in `packages/cli/test/release.test.ts` |
