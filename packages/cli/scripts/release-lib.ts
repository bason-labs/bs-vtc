/**
 * Release helpers (spine AD-26; owner: cli+binary team). Pure functions the release workflow's
 * scripts (`release-checksums.ts`, `release-render.ts`) and their tests share: the targets, the
 * asset names, the `SHA256SUMS` format and the rendering of the Homebrew formula and the
 * installer. They cross no package boundary, so they live here and not in `@vtc/shared`
 * (research 2026-10-14 §6.3).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** One release target: the Bun compile target and the asset's os/arch (spec §4.4). */
export interface ReleaseTarget {
  readonly bun: string;
  readonly os: "darwin" | "linux" | "windows";
  readonly arch: "arm64" | "x64";
}

/** darwin-arm64/x64, linux-x64/arm64, windows-x64 (spec §4.4 "Targets"). */
export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  { bun: "bun-darwin-arm64", os: "darwin", arch: "arm64" },
  { bun: "bun-darwin-x64", os: "darwin", arch: "x64" },
  { bun: "bun-linux-x64", os: "linux", arch: "x64" },
  { bun: "bun-linux-arm64", os: "linux", arch: "arm64" },
  { bun: "bun-windows-x64", os: "windows", arch: "x64" },
];

/** The checksum file every release carries (`sha256sum -c` / `shasum -a 256 -c` compatible). */
export const SHA256SUMS = "SHA256SUMS";

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** A release version without the tag's `v` (`v1.2.3` → `1.2.3`); throws on anything else. */
export const releaseVersion = (tagOrVersion: string): string => {
  const version = tagOrVersion.startsWith("v") ? tagOrVersion.slice(1) : tagOrVersion;
  if (!VERSION.test(version)) throw new Error(`not a release version: ${tagOrVersion}`);
  return version;
};

/** `vtc-<ver>-<os>-<arch>.tar.gz`, or `.zip` for Windows (AD-26 rule 2). */
export const releaseAssetName = (version: string, target: Pick<ReleaseTarget, "os" | "arch">) =>
  `vtc-${releaseVersion(version)}-${target.os}-${target.arch}.${target.os === "windows" ? "zip" : "tar.gz"}`;

/** The binary's file name inside an asset. */
export const binaryName = (target: Pick<ReleaseTarget, "os">): string =>
  target.os === "windows" ? "vtc.exe" : "vtc";

export interface ChecksumEntry {
  readonly name: string;
  readonly sha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9._+-]+$/;

/**
 * The `SHA256SUMS` text: `<sha256>  <name>` per line (two spaces: text mode, which both
 * `sha256sum -c` and `shasum -a 256 -c` accept), sorted by name in byte order, LF endings and a
 * final newline. Names are plain file names, never paths.
 */
export const formatSha256Sums = (entries: readonly ChecksumEntry[]): string => {
  const seen = new Set<string>();
  for (const e of entries) {
    if (!HEX64.test(e.sha256)) throw new Error(`not a lower-case SHA-256: ${e.sha256}`);
    if (!SAFE_NAME.test(e.name)) throw new Error(`not a plain file name: ${e.name}`);
    if (seen.has(e.name)) throw new Error(`listed twice: ${e.name}`);
    seen.add(e.name);
  }
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.map((e) => `${e.sha256}  ${e.name}\n`).join("");
};

/** Parses `SHA256SUMS` (text or binary mode markers); throws on a malformed line. */
export const parseSha256Sums = (text: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._+-]+)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined)
      throw new Error(`malformed ${SHA256SUMS} line: ${JSON.stringify(line)}`);
    if (sums.has(match[2])) throw new Error(`${SHA256SUMS} lists ${match[2]} twice`);
    sums.set(match[2], match[1]);
  }
  return sums;
};

export const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The checksums of every regular file directly in `dir` except `SHA256SUMS` itself. Run after
 * signing (AD-26 rule 3), so the sums cover the bytes users download.
 */
export const checksumDirectory = (dir: string): string =>
  formatSha256Sums(
    readdirSync(dir)
      .filter((name) => name !== SHA256SUMS && statSync(join(dir, name)).isFile())
      .map((name) => ({ name, sha256: sha256File(join(dir, name)) })),
  );

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;

/** Replaces every `{{key}}`; throws on a key `values` lacks, so nothing renders half-filled. */
export const renderTemplate = (
  template: string,
  values: Readonly<Record<string, string>>,
): string =>
  template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`no value for {{${key}}}`);
    return value;
  });

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const checkRepo = (repo: string): string => {
  if (!REPO.test(repo)) throw new Error(`not an <owner>/<repo>: ${repo}`);
  return repo;
};

/**
 * The Homebrew formula (`packaging/homebrew/vtc.rb.tmpl`) for one release: the four macOS and
 * Linux assets, each with its SHA-256 from `SHA256SUMS`. A missing sum fails the render.
 */
export const renderFormula = (
  template: string,
  input: { readonly version: string; readonly repo: string; readonly sums: string },
): string => {
  const version = releaseVersion(input.version);
  const sums = parseSha256Sums(input.sums);
  const values: Record<string, string> = { version, repo: checkRepo(input.repo) };
  for (const target of RELEASE_TARGETS) {
    if (target.os === "windows") continue;
    const asset = releaseAssetName(version, target);
    const sum = sums.get(asset);
    if (sum === undefined) throw new Error(`${SHA256SUMS} has no entry for ${asset}`);
    values[`sha256_${target.os}_${target.arch}`] = sum;
  }
  return renderTemplate(template, values);
};

/** The two placeholders the release fills in `packaging/install.sh`. */
export const INSTALLER_PLACEHOLDERS = {
  repo: "__VTC_REPO__",
  version: "__VTC_VERSION__",
} as const;

/** `packaging/install.sh` as attached to a release: defaults to that release's repo and version. */
export const renderInstaller = (
  script: string,
  input: { readonly version: string; readonly repo: string },
): string => {
  for (const placeholder of Object.values(INSTALLER_PLACEHOLDERS))
    if (!script.includes(placeholder)) throw new Error(`install.sh lacks ${placeholder}`);
  return script
    .replaceAll(INSTALLER_PLACEHOLDERS.repo, checkRepo(input.repo))
    .replaceAll(INSTALLER_PLACEHOLDERS.version, releaseVersion(input.version));
};
