/**
 * The user-level config `~/.vtc/config.yaml` (`USER_CONFIG_FILE`, `UserConfigSchema`; D-ak, spine
 * §5 reading 57): settings that belong to the person and the machine, never to a repo. Today that
 * is `env_passthrough`, the credential variable names the detached daemon keeps (AD-9: it drops
 * them by default). It is read only from the VTC home: `.vtc/project.yaml` is committed, so a
 * repo could otherwise ask for the user's secrets, and `ProjectConfigSchema` rejects the key.
 * Read with `parsePersisted`; a missing file is `{ version: 1 }`. Names only, never values.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { core } from "@vtc/engine";
import { parsePersisted, USER_CONFIG_FILE, UserConfigSchema, type UserConfig } from "@vtc/shared";

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
