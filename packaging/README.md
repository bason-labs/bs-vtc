# Releasing vtc

Owner: the cli+binary team (spine AD-26; spec §4.4; decisions D-az and H-2). Nothing in this
directory has been published, pushed or tagged yet: the release workflow does nothing until the
repository has a GitHub remote.

## Todo

- **sign + notarize once the owner has an Apple Developer ID** (H-2). Until then the release
  ships unsigned macOS binaries with SHA-256 checksums. The `sign-macos` job's body is a
  placeholder, not a working recipe: a runner starts with no certificate and no notary profile.
  To switch it on: store the Developer ID certificate (a base64 `.p12` and its password) and the
  notary credentials (an App Store Connect API key, or Apple ID, team ID and app-specific
  password) as repository secrets; add steps before `codesign` that create a temporary keychain,
  import the certificate into it (`security create-keychain`, `security import`,
  `security set-key-partition-list`) and save the notary credentials into it with
  `xcrun notarytool store-credentials <profile> --keychain <that keychain>`, plus a final step
  that deletes the keychain; then remove `if: ${{ false }}` from the job in
  `.github/workflows/release.yml`, and check under test that
  `macos/entitlements.plist` (only `allow-jit` and `allow-unsigned-executable-memory`) is
  enough; add a key only when a signed smoke test needs it. Signing runs before the
  checksums, so `SHA256SUMS` always covers the signed bytes.
- Push the rendered `vtc.rb` to a tap repository (`<owner>/homebrew-<name>`, `Formula/vtc.rb`).
- Publish the generated plugins to the marketplace release branch (AD-16 rule 5).

## What a release is

`.github/workflows/release.yml` runs on a `v*` tag (and as a dry run from `workflow_dispatch`):

1. **verify**: the tag must equal `VERSION` in `packages/cli/src/version.ts`; then
   `pnpm install --frozen-lockfile` and `pnpm verify` with Bun 1.4.3 installed.
2. **cross-compile**: `pnpm build`, then `scripts/build-binary.ts` once per target
   (darwin-arm64/x64, linux-x64/arm64, windows-x64).
3. **smoke**: each binary on a native runner: `vtc --version` and an MCP `initialize` through
   `vtc engine --mcp` outside any repository.
4. **sign-macos**: skipped until H-2 (see the todo).
5. **package**: `vtc-<version>-<os>-<arch>.tar.gz` (`.zip` for Windows), the rendered Homebrew
   formula `vtc.rb` and installer `install.sh`, and `SHA256SUMS` over all of them (sorted, LF,
   `sha256sum -c` compatible), checked with `sha256sum -c` before upload.
6. **publish** (tags only): attests every asset with GitHub artifact attestations, creates a
   draft release with the assets, then publishes it. With immutable releases switched on in the
   repository settings, the published tag and assets cannot change.

Every `uses:` is pinned to a full commit SHA; the workflow token is `contents: read` everywhere
except the publish job (`contents: write`, `id-token: write`, `attestations: write`).

## Installing and verifying

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

| File                                   | What it is                                                             |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `install.sh`                           | The installer; the release fills in its repository and version         |
| `homebrew/vtc.rb.tmpl`                 | The formula template, one URL and SHA-256 per macOS/Linux platform     |
| `macos/entitlements.plist`             | Hardened-runtime entitlements for signing (unused until H-2)           |
| `../packages/cli/scripts/release-*.ts` | Checksums and rendering, tested in `packages/cli/test/release.test.ts` |
