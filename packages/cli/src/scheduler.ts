/**
 * The auto-resume timer (§6.9 step 4, AD-6 rule 4, AD-12 rule 4): the cli's
 * `AutoResumeScheduler`. The engine decides when to wake; this module persists the single
 * wake-up per repo as `~/.vtc/wake/<repo-key>.json` (mode 0600), so it survives the daemon and a
 * reboot. Nothing is installed in the OS here: the OS timer that acts on these records
 * (`timer.ts`: launchd on macOS, systemd on Linux) is installed by `vtc install`. Every minute it
 * runs `vtc engine --wake-due`, which starts `vtc engine --daemon --wake` for each repo whose
 * time has come ({@link dueWakeups}).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  engineRepoKey,
  IsoDateTimeSchema,
  normalizeRepoRoot,
  type AutoResumeScheduler,
} from "@vtc/shared";

export const WAKE_DIR = "wake";

const WakeRecordSchema = z.strictObject({
  v: z.literal(1),
  repo_root: z.string().min(1).max(4096),
  at: IsoDateTimeSchema,
});
export type WakeRecord = z.infer<typeof WakeRecordSchema>;

const wakeFile = (vtcHome: string, repoRoot: string): string =>
  join(vtcHome, WAKE_DIR, `${engineRepoKey(repoRoot)}.json`);

export const createWakeScheduler = (vtcHome: string): AutoResumeScheduler => ({
  schedule: (repoRoot, at) => {
    const dir = join(vtcHome, WAKE_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: WakeRecord = {
      v: 1,
      repo_root: normalizeRepoRoot(repoRoot),
      at: at.toISOString(),
    };
    const path = wakeFile(vtcHome, repoRoot);
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
    return Promise.resolve();
  },
  cancel: (repoRoot) => {
    rmSync(wakeFile(vtcHome, repoRoot), { force: true });
    return Promise.resolve();
  },
});

/** Every valid wake record (unreadable or malformed files are skipped). */
export const wakeRecords = (vtcHome: string): WakeRecord[] => {
  const dir = join(vtcHome, WAKE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
  } catch {
    return [];
  }
  const out: WakeRecord[] = [];
  for (const name of names) {
    try {
      const parsed = WakeRecordSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (parsed.success && name === `${engineRepoKey(parsed.data.repo_root)}.json`)
        out.push(parsed.data);
    } catch {
      // skipped
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
};

/** The records whose wake-up time is at or before `now`. */
export const dueWakeups = (vtcHome: string, now: Date): WakeRecord[] =>
  wakeRecords(vtcHome).filter((r) => Date.parse(r.at) <= now.getTime());
