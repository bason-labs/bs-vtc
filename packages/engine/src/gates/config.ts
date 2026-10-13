/**
 * The Gate Runner's files: `.vtc/gates.yml` (calibrated gates and the baseline, git-tracked) and
 * the per-machine gate allowlist `~/.vtc/allowlists/<repo-key>.json` (§15, AD-13 rule 10).
 * Readers of persisted data use `parsePersisted` (AD-3 rule 2). `gates.yml` is written as plain
 * YAML (no anchors, aliases, tags, block scalars or multiple documents), so any YAML 1.2 reader,
 * and yaml 2.9.1 in particular, reads it back to the same value.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  gateAllowlistFile,
  GateAllowlistSchema,
  GatesConfigSchema,
  parsePersisted,
  type GateAllowlist,
  type GatesConfig,
  type GatesConfigInput,
} from "@vtc/shared";
import { parse, stringify } from "yaml";

export const GATES_CONFIG_PATH = ".vtc/gates.yml";

export class GatesConfigError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "GatesConfigError";
  }
}

const issues = (error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string =>
  error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");

/** Parses `gates.yml` text (tolerant of keys a newer vtc added, AD-3 rule 2). */
export const parseGatesConfig = (text: string, path = GATES_CONFIG_PATH): GatesConfig => {
  let raw: unknown;
  try {
    raw = parse(text, { uniqueKeys: true, merge: false });
  } catch (error) {
    throw new GatesConfigError(path, error instanceof Error ? error.message : String(error));
  }
  const parsed = parsePersisted(GatesConfigSchema, raw);
  if (!parsed.success) throw new GatesConfigError(path, issues(parsed.error));
  return parsed.data;
};

/** The repo's calibrated gates, or `null` before `vtc calibrate` wrote them. */
export const loadGatesConfig = (repoRoot: string): GatesConfig | null => {
  const abs = join(repoRoot, GATES_CONFIG_PATH);
  if (!existsSync(abs)) return null;
  return parseGatesConfig(readFileSync(abs, "utf8"));
};

const HEADER =
  "# Written by vtc calibrate (spec §7.1). Gate commands run only after a human confirmed them\n" +
  "# in vtc calibrate; editing this file never widens the per-machine allowlist (§15).\n";

/** `gates.yml` text: validated, defaults filled, plain YAML only. */
export const stringifyGatesConfig = (config: GatesConfigInput): string => {
  const valid = GatesConfigSchema.parse(config);
  const body = stringify(valid, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
    minContentWidth: 0,
    blockQuote: false,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    version: "1.2",
  });
  return `${HEADER}${body}`;
};

// ------------------------------------------------------------------ allowlist

/** Absolute path of a repo's allowlist file under the VTC home. */
export const allowlistPath = (vtcHome: string, absRepoRoot: string): string =>
  join(vtcHome, gateAllowlistFile(absRepoRoot));

/**
 * The machine's allowlist for a repo. A missing file is an empty list; an unreadable or invalid
 * one is also empty (nothing runs), never an error that could be mistaken for permission.
 */
export const readAllowlist = (vtcHome: string, absRepoRoot: string): GateAllowlist => {
  const abs = allowlistPath(vtcHome, absRepoRoot);
  const empty: GateAllowlist = { version: 1, commands: [] };
  if (!existsSync(abs)) return empty;
  try {
    const parsed = parsePersisted(GateAllowlistSchema, JSON.parse(readFileSync(abs, "utf8")));
    return parsed.success ? parsed.data : empty;
  } catch {
    return empty;
  }
};

const samePrefix = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((token, i) => b[i] === token);

/**
 * Adds argv prefixes to the allowlist (mode 0600, atomic). Only `vtc calibrate` calls this, and
 * only after a human confirmed each prefix in a terminal (§15): nothing in a repo, a role or the
 * engine widens the allowlist.
 */
export const addToAllowlist = (
  vtcHome: string,
  absRepoRoot: string,
  prefixes: readonly (readonly string[])[],
  now: Date,
): GateAllowlist => {
  const current = readAllowlist(vtcHome, absRepoRoot);
  const commands = [...current.commands];
  for (const prefix of prefixes) {
    if (commands.some((c) => samePrefix(c.argv_prefix, prefix))) continue;
    commands.push({ argv_prefix: [...prefix], confirmed_at: now.toISOString() });
  }
  const next = GateAllowlistSchema.parse({ version: 1, commands });
  const abs = allowlistPath(vtcHome, absRepoRoot);
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  const temp = `${abs}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, abs);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return next;
};
