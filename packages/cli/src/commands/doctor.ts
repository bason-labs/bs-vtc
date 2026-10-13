/**
 * Owner: cli+binary team; scanner pins come from gates/ (gate-runner team). `vtc doctor` checks
 * the prerequisites (§4.4): the runtime, git, the host CLIs and their logins (through
 * `claude auth status --json` and `codex login status` only, AD-9), gh, and on macOS the
 * auto-resume timer. Exits 1 when a required check fails. Downloading the pinned browsers and
 * scanners (§4.4) is not implemented yet: a tracked follow-up of the binary/release wave.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { runDoctorChecks, type DoctorEnv } from "../doctor-checks.js";
import { launchAgentPath } from "../launchd.js";
import { exec } from "../process.js";
import { wakeRecords } from "../scheduler.js";
import type { CommandContext, CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export const defaultDoctorEnv = (ctx: CommandContext): DoctorEnv => ({
  exec,
  versions: process.versions,
  timer: {
    platform: process.platform,
    plist: () => readOrNull(launchAgentPath(homedir())),
    exists: existsSync,
    wakeups: () => wakeRecords(ctx.vtcHome),
  },
});

export const createDoctorCommand = (
  env: (ctx: CommandContext) => DoctorEnv = defaultDoctorEnv,
): CommandSpec => ({
  name: "doctor",
  summary: "Check prerequisites: runtime, git, host CLIs and their logins, gh, auto-resume timer",
  run: (args, ctx) =>
    guarded("doctor", ctx, async () => {
      parseFlags(args, {});
      const checks = await runDoctorChecks(env(ctx));
      for (const c of checks) ctx.io.out(`${MARK[c.status]}  ${c.name.padEnd(12)} ${c.detail}`);
      const failed = checks.filter((c) => c.status === "fail").length;
      ctx.io.out(failed === 0 ? "vtc is ready." : `${String(failed)} check(s) failed.`);
      return failed === 0 ? EXIT.ok : EXIT.failed;
    }),
});

export const command = createDoctorCommand();
