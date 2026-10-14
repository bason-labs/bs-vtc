/**
 * Owner: cli+binary team; the scanner pins and store come from the Gate Runner (gate-runner
 * team). `vtc doctor [--download]` checks the prerequisites (§4.4): the runtime, git, the host
 * CLIs and their logins (through `claude auth status --json` and `codex login status` only,
 * AD-9; an apiKeyHelper-only Claude setup warns, D-ab), gh, the auto-resume timer (launchd on
 * macOS, systemd on Linux, none on Windows in v1: D-aj), the credential variables the detached
 * daemon passes (`~/.vtc/config.yaml` `env_passthrough`, D-ak), the OS sandbox gate commands
 * run in (none fails unless the user opted in with `gates.allow_unsandboxed`, which warns; D-al),
 * the repo's Claude session sandbox and what it misses (D-an), the repo's running engine (one
 * of an incompatible `vtc` fails), the visual stack's browser against its pin (AD-24), the pinned
 * scanners (`gates.createScannerStore`; Checkov without a native build warns, D-u) and the
 * osv-scanner offline database. Since wave 3 also: Claude Code's minimum version for headless
 * runs (`CLAUDE_MIN_VERSION`, AD-25), each adapter's `authStatus()` (what the engine checks before
 * an unattended run), and in a VTC repo the merge level with the Level-3 preflight (AD-23 rule 1).
 * `--download` fetches the missing scanners into `~/.vtc/`, each verified against its pinned
 * SHA-256 (§4.4), and refreshes the osv-scanner database into `~/.vtc/osv-db/` for the repo's
 * lockfiles. `--install-browser` (explicit only, D-ay) installs the browser store and its pin
 * (`browser-install.ts`). Exits 1 when a required check fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER_FACTORIES } from "@vtc/adapters";
import { core, gates, git } from "@vtc/engine";
import type { HostAdapter, HostAuthStatus, HostId } from "@vtc/shared";
import {
  checkBrowser,
  defaultBrowserInstallDeps,
  installBrowser,
  sha256OfFile,
  type BrowserCheckEnv,
} from "../browser-install.js";
import { daemonState } from "../daemon.js";
import {
  checkEngine,
  checkHostAuth,
  checkMergeLevel,
  checkEnvPassthrough,
  checkGateSandbox,
  checkSessionSandbox,
  detectGateSandbox,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorEnv,
  type GateSandboxReport,
  type MergeLevelEnv,
} from "../doctor-checks.js";
import { createGhRemoteMerge } from "../gh-remote-merge.js";
import { exec } from "../process.js";
import { findRepoRoot, isVtcProject } from "../repo.js";
import {
  checkOsvDatabase,
  checkScanners,
  downloadOsvDatabase,
  osvFetchedAt,
  type OsvEnv,
  type ScannerEnv,
} from "../scanner-checks.js";
import { wakeRecords } from "../scheduler.js";
import {
  claudeSessionSandboxOf,
  defaultSessionSandboxEnv,
  type SessionSandboxReport,
} from "../session-sandbox.js";
import { autoResumeTimer, defaultTimerHost } from "../timer.js";
import { readUserConfig, type UserConfigRead } from "../user-config.js";
import { createAdapters } from "../wiring.js";
import { readMergeLevelLedger } from "./merge-level.js";
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
  /** The visual stack's browser pin (AD-24). */
  readonly browser?: BrowserCheckEnv;
  /** `--install-browser`: installs the store and writes the pin (D-ay, explicit only). */
  readonly installBrowser?: (log: (line: string) => void) => Promise<unknown>;
  /** Each adapter's `authStatus()` (AD-25 rule 3); hosts without one are left out. */
  readonly hostAuth?: () => Promise<readonly HostAuthStatus[]>;
  /** The merge level of the VTC repo doctor runs in (AD-23), `null` outside one. */
  readonly mergeLevel?: () => Promise<MergeLevelEnv | null>;
  /** The OS sandbox gate commands run in (D-al), `null` when the machine has none. */
  readonly gateSandbox?: () => Promise<GateSandboxReport>;
  /** The Claude session sandbox of the repo doctor runs in (D-an), `null` outside a repo. */
  readonly sessionSandbox?: () => Promise<SessionSandboxReport | null>;
}

/** `<name> --version` on PATH: a scanner the user installed where no pinned build exists. */
const versionOnPath = async (name: string): Promise<string | null> => {
  const result = await exec(name, ["--version"], { timeoutMs: 15_000 });
  return result.code === 0 ? result.stdout.trim().split(/\r?\n/)[0] || name : null;
};

/**
 * The base branch the engine opens PRs against, from `git rev-parse --abbrev-ref HEAD`, as the
 * engine's `baseBranch` picks it: the current branch, or `main` when HEAD is detached or on a
 * `vtc/` branch. Doctor's Level-3 preflight checks that branch.
 */
export const engineBaseBranch = (abbrevHead: string): string => {
  const out = abbrevHead.trim();
  return out === "" || out === "HEAD" || out.startsWith("vtc/") ? "main" : out;
};

/**
 * Every adapter's `authStatus()` (AD-25 rule 3). One that rejects (its host CLI is missing, say)
 * counts as `logged_in: null`, "its status command did not run", so doctor still reports every
 * other check; adapters without a status command are left out.
 */
export const gatherHostAuth = async (
  adapters: Partial<Record<HostId, Pick<HostAdapter, "authStatus">>>,
  now: () => Date,
): Promise<HostAuthStatus[]> => {
  const statuses = await Promise.all(
    (Object.entries(adapters) as [HostId, Pick<HostAdapter, "authStatus">][]).map(
      async ([host, adapter]): Promise<HostAuthStatus | null> => {
        if (adapter.authStatus === undefined) return null;
        try {
          return await adapter.authStatus();
        } catch {
          return { host, logged_in: null, method: null, checked_at: now().toISOString() };
        }
      },
    ),
  );
  return statuses.filter((s): s is HostAuthStatus => s !== null);
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
    browser: { vtcHome: ctx.vtcHome, sha256: sha256OfFile },
    installBrowser: (log) => installBrowser(ctx.vtcHome, defaultBrowserInstallDeps(log)),
    hostAuth: async () => {
      // constructed only to ask; no plugin is extracted or installed
      const adapters = createAdapters(ADAPTER_FACTORIES, {
        vtcHome: ctx.vtcHome,
        pluginDir: (host, home) => join(home, "plugins", "doctor", host),
      });
      try {
        return await gatherHostAuth(adapters, () => new Date());
      } finally {
        await Promise.allSettled(Object.values(adapters).map((a) => a.dispose()));
      }
    },
    mergeLevel: async () => {
      const repoRoot = await findRepoRoot(ctx.cwd);
      if (repoRoot === null || !isVtcProject(repoRoot)) return null;
      const remote = createGhRemoteMerge({ repoRoot });
      // the branch the engine's PRs target (engine `baseBranch`): the current branch, or `main`
      // when HEAD is detached or on a VTC branch
      const head = await git.runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], {
        allowFailure: true,
      });
      return {
        configured: core.loadProjectConfig(repoRoot).merge_level,
        ledger: readMergeLevelLedger(repoRoot).entries,
        base: engineBaseBranch(head.code === 0 ? head.stdout.toString("utf8") : ""),
        remote: () => remote.remote(),
        policy: (b) => remote.policy(b),
      };
    },
    gateSandbox: () => Promise.resolve(detectGateSandbox()),
    sessionSandbox: async () => {
      const repoRoot = await findRepoRoot(ctx.cwd);
      return repoRoot === null
        ? null
        : claudeSessionSandboxOf(repoRoot, ctx.vtcHome, defaultSessionSandboxEnv(), ctx.cwd);
    },
  };
};

export const createDoctorCommand = (
  env: (ctx: CommandContext) => DoctorCommandEnv = defaultDoctorEnv,
): CommandSpec => ({
  name: "doctor",
  summary:
    "Check prerequisites (runtime, git, host CLIs, versions and logins, gh, auto-resume timer, env passthrough, gate sandbox, session sandbox, the repo's engine and merge level, the browser, pinned scanners, osv database); --download fetches missing scanners and the osv database; --install-browser installs the visual stack's browser",
  run: (args, ctx) =>
    guarded("doctor", ctx, async () => {
      const { values } = parseFlags(args, {
        download: { type: "boolean" },
        "install-browser": { type: "boolean" },
      });
      const e = env(ctx);
      if (values["install-browser"] === true) {
        if (e.installBrowser === undefined) throw new Error("this vtc cannot install a browser");
        try {
          await e.installBrowser((line) => {
            ctx.io.out(line);
          });
        } catch (error) {
          ctx.io.err(
            `vtc doctor: the browser was not installed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return EXIT.failed;
        }
      }
      const checks = await runDoctorChecks(e);
      if (e.hostAuth !== undefined) {
        const auth = checkHostAuth(await e.hostAuth());
        if (auth !== null) checks.push(auth);
      }
      const userConfig = e.userConfig?.() ?? null;
      if (userConfig !== null) checks.push(checkEnvPassthrough(userConfig));
      if (e.gateSandbox !== undefined)
        checks.push(checkGateSandbox(await e.gateSandbox(), userConfig));
      const session = e.sessionSandbox === undefined ? null : await e.sessionSandbox();
      if (session !== null) checks.push(checkSessionSandbox(session));
      if (e.browser !== undefined) checks.push(await checkBrowser(e.browser));
      const engine = e.engine === undefined ? null : await e.engine();
      if (engine !== null) checks.push(engine);
      if (e.mergeLevel !== undefined) {
        try {
          const level = await e.mergeLevel();
          if (level !== null) checks.push(await checkMergeLevel(level));
        } catch (error) {
          // e.g. the ledger is a symlink: report it and run the other checks
          checks.push({
            name: "merge level",
            status: "fail",
            detail: `cannot read it: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
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
