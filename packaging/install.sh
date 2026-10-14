#!/bin/sh
# Install the vtc binary from a GitHub release (spine AD-26 rule 4; owner: cli+binary team).
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://github.com/<owner>/<repo>/releases/download/v<version>/install.sh | sh
#
# What it does, and nothing else:
#   - downloads vtc-<version>-<os>-<arch>.tar.gz and SHA256SUMS of one release into a temporary
#     directory (removed on exit), over HTTPS only;
#   - verifies the archive against SHA256SUMS with sha256sum or shasum -a 256, and stops when
#     neither exists or the sum does not match (it never installs an unverified file);
#   - with VTC_VERIFY_ATTESTATION=1 also runs gh attestation verify on the archive;
#   - moves the binary into $VTC_INSTALL_DIR (default $HOME/.local/bin) with an atomic rename.
# It never uses sudo and never edits a shell rc file. A checksum shows the download is intact,
# not who built it: to check provenance, verify the attestation (see packaging/README.md).
#
# Settings (environment): VTC_VERSION (default: the release this script came from),
# VTC_REPO (owner/repo), VTC_INSTALL_DIR, VTC_VERIFY_ATTESTATION=1.
#
# The whole body is in main, called on the last line, so a partly downloaded script runs nothing.

set -eu

main() {
  repo="${VTC_REPO:-__VTC_REPO__}"
  version="${VTC_VERSION:-__VTC_VERSION__}"
  version="${version#v}"
  install_dir="${VTC_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}"

  case "$repo" in
    __VTC_*__ | "") fail "set VTC_REPO=<owner>/<repo> (this install.sh was not taken from a release)" ;;
  esac
  case "$version" in
    __VTC_*__ | "") fail "set VTC_VERSION=<version> (this install.sh was not taken from a release)" ;;
  esac

  target="$(detect_target)"
  asset="vtc-${version}-${target}.tar.gz"
  base="https://github.com/${repo}/releases/download/v${version}"
  hash_tool="$(find_hash_tool)"

  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t vtc-install)"
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  say "Downloading vtc ${version} for ${target}"
  download "${base}/${asset}" "${tmp}/${asset}"
  download "${base}/SHA256SUMS" "${tmp}/SHA256SUMS"

  expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "${tmp}/SHA256SUMS")"
  case "$expected" in
    "") fail "SHA256SUMS lists no ${asset}" ;;
  esac
  case "$expected" in
    *[!0-9a-f]*) fail "SHA256SUMS has a malformed entry for ${asset}" ;;
  esac
  [ "${#expected}" -eq 64 ] || fail "SHA256SUMS has a malformed entry for ${asset}"
  actual="$(hash_file "$hash_tool" "${tmp}/${asset}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual}; nothing was installed"
  say "Checksum verified (${hash_tool})"

  if [ "${VTC_VERIFY_ATTESTATION:-0}" = "1" ]; then
    command -v gh >/dev/null 2>&1 || fail "VTC_VERIFY_ATTESTATION=1 needs gh on PATH"
    gh attestation verify "${tmp}/${asset}" -R "$repo" >/dev/null || fail "attestation verification failed for ${asset}"
    say "Attestation verified"
  fi

  mkdir -p "${tmp}/x"
  tar -xzf "${tmp}/${asset}" -C "${tmp}/x"
  [ -f "${tmp}/x/vtc" ] || fail "${asset} holds no vtc binary"
  chmod 0755 "${tmp}/x/vtc"

  mkdir -p "$install_dir"
  staged="${install_dir}/.vtc.install.$$"
  cp "${tmp}/x/vtc" "$staged" || { rm -f "$staged"; fail "cannot write to ${install_dir}"; }
  mv -f "$staged" "${install_dir}/vtc" || { rm -f "$staged"; fail "cannot install into ${install_dir}"; }
  say "Installed ${install_dir}/vtc"

  case ":${PATH}:" in
    *":${install_dir}:"*) ;;
    *) say "Note: ${install_dir} is not on your PATH; add it in your shell profile to run vtc" ;;
  esac
  say "Next: vtc doctor"
}

say() {
  printf '%s\n' "vtc-install: $*"
}

fail() {
  printf '%s\n' "vtc-install: error: $*" >&2
  exit 1
}

detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) fail "on Windows, download vtc-<version>-windows-x64.zip from the release page" ;;
    *) fail "no vtc build for ${os}" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "no vtc build for ${os} on ${arch}" ;;
  esac
  # An x64 shell under Rosetta on Apple silicon still gets the native arm64 build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      arch=arm64
    fi
  fi
  printf '%s\n' "${os}-${arch}"
}

find_hash_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s\n' shasum
  else
    fail "neither sha256sum nor shasum is installed, so the download cannot be verified; nothing was installed"
  fi
}

hash_file() {
  case "$1" in
    sha256sum) sha256sum "$2" | awk '{ print $1 }' ;;
    shasum) shasum -a 256 "$2" | awk '{ print $1 }' ;;
  esac
}

download() {
  curl --proto '=https' --tlsv1.2 -fsSL -o "$2" "$1" || fail "download failed: $1"
}

main "$@"
