/**
 * Owner: cli+binary team; the scanner pins and store come from the Gate Runner (gate-runner
 * team). `vtc doctor [--download]` checks the prerequisites (§4.4): the runtime, git, the host
 * CLIs and their logins (through `claude auth status --json` and `codex login status` only,
 * AD-9), gh, the auto-resume timer (launchd on macOS, systemd on Linux), the repo's running engine
 * (one of an incompatible `vtc` fails), Playwright's Chromium (not provisioned yet: a warning) and
 * the pinned scanners.
 * `--download` fetches the missing scanners into `~/.vtc/`, each verified against its pinned
 * SHA-256 (§4.4). Exits 1 when a required check fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { gates } from "@vtc/engine";
import { daemonState } from "../daemon.js";
import {
  checkChromium,
  checkEngine,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorEnv,
} from "../doctor-checks.js";
import { exec } from "../process.js";
import { findRepoRoot } from "../repo.js";
import { checkScanners, engineScannerStore, type ScannerEnv } from "../scanner-checks.js";
import { wakeRecords } from "../scheduler.js";
import { autoResumeTimer, defaultTimerHost } from "../timer.js";
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

/** What `vtc doctor` checks; each optional part is skipped when absent. */
export interface DoctorCommandEnv extends DoctorEnv {
  readonly scanners?: ScannerEnv;
  /** The running engine of the repo doctor runs in, or `null` (no repo, no daemon). */
  readonly engine?: () => Promise<DoctorCheck | null>;
  /** Playwright's Chromium for Visual QA (§4.4). */
  readonly chromium?: () => DoctorCheck;
}

export const defaultDoctorEnv = (ctx: CommandContext): DoctorCommandEnv => {
  const timer = autoResumeTimer(process.platform);
  return {
    exec,
    versions: process.versions,
    ...(timer === null
      ? {}
      : {
          timer: {
            kind: timer.kind,
            read: () => readOrNull(timer.file(defaultTimerHost())),
            program: timer.program,
            exists: existsSync,
            wakeups: () => wakeRecords(ctx.vtcHome),
          },
        }),
    scanners: { open: engineScannerStore(gates), vtcHome: ctx.vtcHome },
    engine: async () => {
      const repoRoot = await findRepoRoot(ctx.cwd);
      return repoRoot === null
        ? null
        : checkEngine(repoRoot, await daemonState(ctx.vtcHome, repoRoot));
    },
    chromium: checkChromium,
  };
};

export const createDoctorCommand = (
  env: (ctx: CommandContext) => DoctorCommandEnv = defaultDoctorEnv,
): CommandSpec => ({
  name: "doctor",
  summary:
    "Check prerequisites (runtime, git, host CLIs and logins, gh, auto-resume timer, the repo's engine, pinned scanners); --download fetches missing scanners",
  run: (args, ctx) =>
    guarded("doctor", ctx, async () => {
      const { values } = parseFlags(args, { download: { type: "boolean" } });
      const e = env(ctx);
      const checks = await runDoctorChecks(e);
      if (e.chromium !== undefined) checks.push(e.chromium());
      const engine = e.engine === undefined ? null : await e.engine();
      if (engine !== null) checks.push(engine);
      if (e.scanners !== undefined) {
        const mode = values.download === true ? "download" : "check";
        checks.push(
          ...(await checkScanners(e.scanners, mode, (line) => {
            ctx.io.out(line);
          })),
        );
      }
      for (const c of checks) ctx.io.out(`${MARK[c.status]}  ${c.name.padEnd(12)} ${c.detail}`);
      const failed = checks.filter((c) => c.status === "fail").length;
      ctx.io.out(failed === 0 ? "vtc is ready." : `${String(failed)} check(s) failed.`);
      return failed === 0 ? EXIT.ok : EXIT.failed;
    }),
});

export const command = createDoctorCommand();
