/**
 * Owner: cli+binary team; scanner pins come from gates/ (gate-runner team). `vtc doctor` checks
 * the prerequisites (§4.4): the runtime, git, the host CLIs and their logins (through
 * `claude auth status --json` and `codex login status` only, AD-9), and gh. Exits 1 when a
 * required check fails. Downloading the pinned browsers and scanners is not implemented yet.
 */
import { runDoctorChecks, type DoctorEnv } from "../doctor-checks.js";
import { exec } from "../process.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

export const createDoctorCommand = (
  env: () => DoctorEnv = () => ({ exec, versions: process.versions }),
): CommandSpec => ({
  name: "doctor",
  summary: "Check prerequisites: runtime, git, host CLIs and their logins, gh",
  run: (args, ctx) =>
    guarded("doctor", ctx, async () => {
      parseFlags(args, {});
      const checks = await runDoctorChecks(env());
      for (const c of checks) ctx.io.out(`${MARK[c.status]}  ${c.name.padEnd(12)} ${c.detail}`);
      const failed = checks.filter((c) => c.status === "fail").length;
      ctx.io.out(failed === 0 ? "vtc is ready." : `${String(failed)} check(s) failed.`);
      return failed === 0 ? EXIT.ok : EXIT.failed;
    }),
});

export const command = createDoctorCommand();
