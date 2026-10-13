/**
 * Owner: cli+binary team; the scanner pins and store come from the Gate Runner (gate-runner
 * team). `vtc doctor [--download]` checks the prerequisites (§4.4): the runtime, git, the host
 * CLIs and their logins (through `claude auth status --json` and `codex login status` only,
 * AD-9; an apiKeyHelper-only Claude setup warns, D-ab), gh, the auto-resume timer (launchd on
 * macOS, systemd on Linux, none on Windows in v1: D-aj), the credential variables the detached
 * daemon passes (`~/.vtc/config.yaml` `env_passthrough`, D-ak), the OS sandbox gate commands
 * run in (none fails unless the user opted in with `gates.allow_unsandboxed`, which warns; D-al),
 * the repo's Claude session sandbox and what it misses (D-an), the repo's running engine (one
 * of an incompatible `vtc` fails), Playwright's Chromium (pin deferred: a warning, D-ai), the
 * pinned scanners (`gates.createScannerStore`; Checkov without a native build warns, D-u) and the
 * osv-scanner offline database.
 * `--download` fetches the missing scanners into `~/.vtc/`, each verified against its pinned
 * SHA-256 (§4.4), and refreshes the osv-scanner database into `~/.vtc/osv-db/` for the repo's
 * lockfiles. Exits 1 when a required check fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { gates } from "@vtc/engine";
import { daemonState } from "../daemon.js";
import type { GateSandboxKind } from "@vtc/shared";
import {
  checkChromium,
  checkEngine,
  checkEnvPassthrough,
  checkGateSandbox,
  checkSessionSandbox,
  detectGateSandbox,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorEnv,
} from "../doctor-checks.js";
import { exec } from "../process.js";
import { findRepoRoot } from "../repo.js";
import {
  checkOsvDatabase,
  checkScanners,
  downloadOsvDatabase,
  osvFetchedAt,
  type OsvEnv,
  type ScannerEnv,
} from "../scanner-checks.js";
import { wakeRecords } from "../scheduler.js";
import { claudeSessionSandboxOf, type SessionSandboxReport } from "../session-sandbox.js";
import { autoResumeTimer, defaultTimerHost } from "../timer.js";
import { readUserConfig, type UserConfigRead } from "../user-config.js";
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
  /** The osv-scanner offline database; checked with the scanners. */
  readonly osv?: OsvEnv;
  /** `~/.vtc/config.yaml` (D-ak). */
  readonly userConfig?: () => UserConfigRead;
  /** The running engine of the repo doctor runs in, or `null` (no repo, no daemon). */
  readonly engine?: () => Promise<DoctorCheck | null>;
  /** Playwright's Chromium for Visual QA (§4.4). */
  readonly chromium?: () => DoctorCheck;
  /** The OS sandbox gate commands run in (D-al), `null` when the machine has none. */
  readonly gateSandbox?: () => Promise<Exclude<GateSandboxKind, "none"> | null>;
  /** The Claude session sandbox of the repo doctor runs in (D-an), `null` outside a repo. */
  readonly sessionSandbox?: () => Promise<SessionSandboxReport | null>;
}

/** `<name> --version` on PATH: a scanner the user installed where no pinned build exists. */
const versionOnPath = async (name: string): Promise<string | null> => {
  const result = await exec(name, ["--version"], { timeoutMs: 15_000 });
  return result.code === 0 ? result.stdout.trim().split(/\r?\n/)[0] || name : null;
};

export const defaultDoctorEnv = (ctx: CommandContext): DoctorCommandEnv => {
  const timer = autoResumeTimer(process.platform);
  return {
    exec,
    versions: process.versions,
    ...(timer === null
      ? process.platform === "win32"
        ? { timer: "unsupported" as const }
        : {}
      : {
          timer: {
            kind: timer.kind,
            read: () => readOrNull(timer.file(defaultTimerHost())),
            program: timer.program,
            exists: existsSync,
            wakeups: () => wakeRecords(ctx.vtcHome),
          },
        }),
    scanners: { open: gates.createScannerStore, vtcHome: ctx.vtcHome, onPath: versionOnPath },
    osv: {
      fetchedAt: osvFetchedAt,
      checkout: () => findRepoRoot(ctx.cwd),
      download: downloadOsvDatabase,
    },
    userConfig: () => readUserConfig(ctx.vtcHome),
    engine: async () => {
      const repoRoot = await findRepoRoot(ctx.cwd);
      return repoRoot === null
        ? null
        : checkEngine(repoRoot, await daemonState(ctx.vtcHome, repoRoot));
    },
    chromium: checkChromium,
    gateSandbox: () => detectGateSandbox(process.platform, existsSync, exec),
    sessionSandbox: async () => {
      const repoRoot = await findRepoRoot(ctx.cwd);
      return repoRoot === null ? null : claudeSessionSandboxOf(repoRoot, ctx.vtcHome);
    },
  };
};

export const createDoctorCommand = (
  env: (ctx: CommandContext) => DoctorCommandEnv = defaultDoctorEnv,
): CommandSpec => ({
  name: "doctor",
  summary:
    "Check prerequisites (runtime, git, host CLIs and logins, gh, auto-resume timer, env passthrough, gate sandbox, session sandbox, the repo's engine, pinned scanners, osv database); --download fetches missing scanners and the osv database",
  run: (args, ctx) =>
    guarded("doctor", ctx, async () => {
      const { values } = parseFlags(args, { download: { type: "boolean" } });
      const e = env(ctx);
      const checks = await runDoctorChecks(e);
      const userConfig = e.userConfig?.() ?? null;
      if (userConfig !== null) checks.push(checkEnvPassthrough(userConfig));
      if (e.gateSandbox !== undefined)
        checks.push(checkGateSandbox(await e.gateSandbox(), userConfig));
      const session = e.sessionSandbox === undefined ? null : await e.sessionSandbox();
      if (session !== null) checks.push(checkSessionSandbox(session));
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
        if (e.osv !== undefined) {
          if (mode === "download") ctx.io.out("Refreshing the osv-scanner offline database...");
          const store = (e.scanners.open ?? gates.createScannerStore)({
            vtcHome: e.scanners.vtcHome,
          });
          checks.push(await checkOsvDatabase(e.osv, e.scanners.vtcHome, store, mode));
        }
      }
      for (const c of checks) ctx.io.out(`${MARK[c.status]}  ${c.name.padEnd(12)} ${c.detail}`);
      const failed = checks.filter((c) => c.status === "fail").length;
      ctx.io.out(failed === 0 ? "vtc is ready." : `${String(failed)} check(s) failed.`);
      return failed === 0 ? EXIT.ok : EXIT.failed;
    }),
});

export const command = createDoctorCommand();
