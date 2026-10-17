/**
 * Per-action staging directories under the engine's guard dir (AD-27 rule 1): every body, comment
 * and evidence file `gh` reads lives in one, under a neutral relative name, and `gh` runs with it as
 * its cwd, so a reference that fails to upload never shows a user path. Created 0700; removed when
 * the action ends.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Staging {
  readonly dir: string;
  /** Writes `name` (a neutral relative name) and returns it. */
  write(name: string, content: string | Uint8Array): string;
  dispose(): void;
}

const NEUTRAL = /^[a-z0-9][a-z0-9._-]{0,80}$/;

const privateDir = (abs: string): void => {
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  if (lstatSync(abs).isSymbolicLink()) throw new Error("staging directory is a symlink");
  chmodSync(abs, 0o700);
};

/** A new staging directory under `root` (`<guard dir>/upstream/staging`). */
export const createStaging = (root: string): Staging => {
  privateDir(root);
  const dir = join(root, randomBytes(8).toString("hex"));
  privateDir(dir);
  return {
    dir,
    write: (name, content) => {
      if (!NEUTRAL.test(name)) throw new Error("staging names are neutral and relative");
      writeFileSync(join(dir, name), content, { mode: 0o600, flag: "w" });
      return name;
    },
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** Where staging directories go inside the guard dir. */
export const stagingRootFor = (guardDir: string): string => join(guardDir, "upstream", "staging");
