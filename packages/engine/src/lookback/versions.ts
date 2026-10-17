/**
 * Prompt identity and the immutable version files (AD-21 rules 1 and 3).
 *
 * A version is `effectivePromptSha(locked, editable)`; `locked_sha256` and `editable_sha256` are the
 * SHA-256 of each trimmed section, as `splitRolePrompt` returns them. Version files live only under
 * the VTC home (`~/.vtc/lookback/prompts/<role>[-<mode>]/<host>/<sha8>.md`): YAML frontmatter
 * (`PromptVersionFrontmatter`) and the editable section. A file is written once and never
 * changed; reading one re-checks that its section still hashes to the version it names.
 */
import {
  effectivePromptSha,
  HostIdSchema,
  LOOKBACK_HOME,
  parsePersisted,
  PromptVersionFrontmatterSchema,
  RoleIdSchema,
  sha256Hex,
  Sha256HexSchema,
  SlugSchema,
  type HostId,
  type PromptVersionFrontmatter,
  type PromptVersionRef,
} from "@vtc/shared";
import { join } from "node:path";
import { parseYaml, toYaml } from "../core/index.js";
import { readTextIfExists, readTextIfExistsSync, writeNewFile } from "./files.js";

/** SHA-256 of a trimmed prompt section. */
export const sectionSha = (section: string): string => sha256Hex(section.trim());

/** The version a locked core and an editable section make together. */
export const promptVersionRef = (target: {
  readonly role: string;
  readonly mode?: string | undefined;
  readonly host: HostId;
  readonly locked: string;
  readonly editable: string;
}): PromptVersionRef => ({
  role: RoleIdSchema.parse(target.role),
  ...(target.mode === undefined ? {} : { mode: SlugSchema.parse(target.mode) }),
  host: HostIdSchema.parse(target.host),
  locked_sha256: sectionSha(target.locked),
  editable_sha256: sectionSha(target.editable),
  effective_sha256: effectivePromptSha(target.locked, target.editable),
});

/** Absolute path of a version file under the VTC home. */
export const promptVersionPath = (
  vtcHome: string,
  target: { readonly role: string; readonly mode?: string | undefined; readonly host: string },
  effectiveSha: string,
): string =>
  join(
    vtcHome,
    LOOKBACK_HOME.promptsDir,
    `${RoleIdSchema.parse(target.role)}${target.mode === undefined ? "" : `-${SlugSchema.parse(target.mode)}`}`,
    HostIdSchema.parse(target.host),
    `${Sha256HexSchema.parse(effectiveSha).slice(0, 8)}.md`,
  );

const FENCE = "---";

const render = (frontmatter: PromptVersionFrontmatter, editable: string): string =>
  `${FENCE}\n${toYaml(frontmatter)}${FENCE}\n${editable.trim()}\n`;

export class PromptVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptVersionError";
  }
}

/**
 * Writes a version file once. Writing the same version again is a no-op; a different file at the
 * same path (another version with the same 8-hex prefix, or a changed one) is refused.
 */
export const storePromptVersion = async (
  vtcHome: string,
  frontmatter: PromptVersionFrontmatter,
  editable: string,
): Promise<string> => {
  const valid = PromptVersionFrontmatterSchema.parse(frontmatter);
  if (sectionSha(editable) !== valid.version.editable_sha256) {
    throw new PromptVersionError(
      "the editable section does not match the version's editable_sha256",
    );
  }
  const path = promptVersionPath(vtcHome, valid.version, valid.version.effective_sha256);
  // Published with a link, never a rename: a concurrent store (or a cli gesture) that got there
  // first is never overwritten, and its file is checked like any existing one.
  if (await writeNewFile(path, render(valid, editable))) return path;
  const existing = await readTextIfExists(path);
  const parsed = existing === undefined ? undefined : parseVersionFile(existing);
  if (parsed?.frontmatter.version.effective_sha256 === valid.version.effective_sha256) return path;
  throw new PromptVersionError(`another version already lives at ${path}; versions are immutable`);
};

const parseVersionFile = (
  text: string,
): { readonly frontmatter: PromptVersionFrontmatter; readonly editable: string } | undefined => {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FENCE}\n`)) return undefined;
  const end = normalized.indexOf(`\n${FENCE}\n`, FENCE.length);
  if (end === -1) return undefined;
  let raw: unknown;
  try {
    raw = parseYaml(normalized.slice(FENCE.length + 1, end + 1));
  } catch {
    return undefined;
  }
  const parsed = parsePersisted(PromptVersionFrontmatterSchema, raw);
  if (!parsed.success) return undefined;
  return { frontmatter: parsed.data, editable: normalized.slice(end + FENCE.length + 2).trim() };
};

type StoredVersion = { readonly frontmatter: PromptVersionFrontmatter; readonly editable: string };
type VersionTarget = {
  readonly role: string;
  readonly mode?: string | undefined;
  readonly host: string;
};

/** A version file's text checked against the version it must be and the locked core it runs with. */
const checkedVersion = (
  text: string | undefined,
  target: VersionTarget,
  effectiveSha: string,
  locked: string,
): StoredVersion | undefined => {
  if (text === undefined) return undefined;
  const parsed = parseVersionFile(text);
  if (parsed === undefined) return undefined;
  const { version } = parsed.frontmatter;
  if (
    version.effective_sha256 !== effectiveSha ||
    version.role !== target.role ||
    version.mode !== target.mode ||
    version.host !== target.host ||
    sectionSha(parsed.editable) !== version.editable_sha256 ||
    sectionSha(locked) !== version.locked_sha256 ||
    effectivePromptSha(locked, parsed.editable) !== effectiveSha
  ) {
    return undefined;
  }
  return parsed;
};

/**
 * The editable section of a stored version, checked against the locked core it will run with:
 * `undefined` when the file is missing, malformed, or does not hash to `effectiveSha`.
 */
export const loadPromptVersion = async (
  vtcHome: string,
  target: VersionTarget,
  effectiveSha: string,
  locked: string,
): Promise<StoredVersion | undefined> =>
  checkedVersion(
    await readTextIfExists(promptVersionPath(vtcHome, target, effectiveSha)),
    target,
    effectiveSha,
    locked,
  );

/** {@link loadPromptVersion}, synchronously (for the engine's synchronous prompt selector). */
export const loadPromptVersionSync = (
  vtcHome: string,
  target: VersionTarget,
  effectiveSha: string,
  locked: string,
): StoredVersion | undefined =>
  checkedVersion(
    readTextIfExistsSync(promptVersionPath(vtcHome, target, effectiveSha)),
    target,
    effectiveSha,
    locked,
  );
