/**
 * The user-level config `~/.vtc/config.yaml` (`USER_CONFIG_FILE`, `UserConfigSchema`; D-ak, spine
 * §5 reading 57): settings that belong to the person and the machine, never to a repo:
 * `env_passthrough`, the credential variable names the detached daemon keeps (AD-9: it drops
 * them by default), `gates.allow_unsandboxed` (D-al, reading 69), the opt-in to run gates
 * without an OS sandbox on a machine that has none, the research fetchers' key variables and
 * the optional search provider (readings 120, 156) and the price table (reading 152). They are
 * read only from the VTC home: `.vtc/project.yaml` is committed, so a repo could otherwise ask for the user's secrets or
 * switch the gate sandbox off, and `ProjectConfigSchema` rejects both keys.
 * Read with `parsePersisted`; a missing file is `{ version: 1 }`. Names only, never values.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { core } from "@vtc/engine";
import {
  gatesAllowUnsandboxed,
  parsePersisted,
  USER_CONFIG_FILE,
  UserConfigSchema,
  type FetcherId,
  type ModelPrice,
  type SearchProvider,
  type UserConfig,
} from "@vtc/shared";

export type UserConfigRead =
  | { readonly ok: true; readonly path: string; readonly config: UserConfig }
  | { readonly ok: false; readonly path: string; readonly error: string };

export const userConfigPath = (vtcHome: string): string => join(vtcHome, USER_CONFIG_FILE);

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** The user's config, `{ version: 1 }` when there is no file, or why it does not parse. */
export const readUserConfig = (vtcHome: string): UserConfigRead => {
  const path = userConfigPath(vtcHome);
  let raw: unknown = { version: 1 };
  try {
    raw = core.parseYaml(readFileSync(path, "utf8")) ?? {};
  } catch (error) {
    if (!isMissing(error))
      return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = parsePersisted(UserConfigSchema, raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, path, error: issues };
  }
  return { ok: true, path, config: parsed.data };
};

/** The names to pass through: none when the file does not parse (credentials stay dropped). */
export const passthroughOf = (read: UserConfigRead): readonly string[] =>
  read.ok ? read.config.env_passthrough : [];

/**
 * `research.search_provider` (H-3, spine §5 reading 156): the optional keyed provider behind the
 * `search` fetcher (`EngineDeps.researchSearchProvider`). `undefined` by default, and when the
 * file does not parse: research search then runs on the host's own web search in the Research
 * Analyst's role session, and the `search` fetcher sends nothing.
 */
export const researchSearchProviderOf = (read: UserConfigRead): SearchProvider | undefined =>
  read.ok ? read.config.research?.search_provider : undefined;

/**
 * The environment variable names `research.api_keys` gives each research fetcher (AD-22 rule 1,
 * spine §5 reading 120); none when the file does not parse. The `search` entry counts only when
 * a provider is named ({@link researchSearchProviderOf}, H-3): without one no search key is kept
 * or sent. Names only: the daemon keeps them in its environment, and the values are read at call
 * time ({@link researchApiKeyOf}).
 */
export const researchKeyNamesOf = (read: UserConfigRead): Partial<Record<FetcherId, string>> => {
  if (!read.ok) return {};
  const { search, ...others } = read.config.research?.api_keys ?? {};
  return search === undefined || researchSearchProviderOf(read) === undefined
    ? others
    : { ...others, search };
};

/**
 * `EngineDeps.researchApiKey`: a fetcher's key read from `env` at call time, or `undefined`
 * when none is named (then no research key is injected at all).
 */
export const researchApiKeyOf = (
  read: UserConfigRead,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ((fetcher: FetcherId) => string | undefined) | undefined => {
  const names = researchKeyNamesOf(read);
  if (Object.keys(names).length === 0) return undefined;
  return (fetcher) => {
    const name = names[fetcher];
    const value = name === undefined ? undefined : env[name];
    return value === undefined || value === "" ? undefined : value;
  };
};

/** `gates.allow_unsandboxed`: false when the file does not parse (the gate sandbox stays required). */
export const allowUnsandboxedOf = (read: UserConfigRead): boolean =>
  read.ok && gatesAllowUnsandboxed(read.config);

/**
 * `prices` (§11, H-1; spine §5 reading 152): the engine's price table, model id → list price.
 * Empty when the file does not parse: then no model is priced, and a host that reports no cost
 * (Codex) runs no engine-launched role, which fails closed.
 */
export const pricesOf = (read: UserConfigRead): Readonly<Record<string, ModelPrice>> =>
  read.ok ? (read.config.prices ?? {}) : {};
