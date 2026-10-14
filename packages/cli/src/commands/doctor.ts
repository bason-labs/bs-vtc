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
 * Since the wave-3 closing round: an API-key login warns with `API_KEY_BILLING_WARNING` and fails
 * nothing (D-bq); the user's Claude hooks and enabled plugins that headless role runs load under
 * `--setting-sources user` are listed as a §7 accepted residual, read from the user's
 * `settings.json` only (D-bp); research search on the host's own web search, or the configured
 * keyed provider (H-3); and whether the user's own yt-dlp is there for YouTube transcripts (D-bs).
 * Since round 4 (AD-27): the gh login through `gh auth status`'s exit code only, the evidence
 * hosting gh allows and the browser capture uses, ffmpeg (optional: GIF previews), the project's
 * automation settings and notes (`automationFor`), the neutral notice for provider billing (D-ci)
 * and where research roles get host web search (D-cf).
 * `info` lines report and never fail.
 * `--download` fetches the missing scanners into `~/.vtc/`, each verified against its pinned
 * SHA-256 (§4.4), and refreshes the osv-scanner database into `~/.vtc/osv-db/` for the repo's
 * lockfiles. `--install-browser` (explicit only, D-ay) installs the browser store and its pin
 * (`browser-install.ts`). Exits 1 when a required check fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ADAPTER_FACTORIES } from "@vtc/adapters";
import { core, gates, git } from "@vtc/engine";
import type { HostAdapter, HostAuthStatus, HostId, ProjectConfig } from "@vtc/shared";
import {
  checkAutomation,
  checkEvidence,
  checkFfmpeg,
  checkGhLogin,
  checkHostWeb,
  checkProviderBilling,
  checkUpstreamCheckout,
  inspectCheckout,
  type CheckoutFacts,
} from "../automation-checks.js";
import {
  probeAutomation,
  requestedHostingOf,
  shippedAutomationFactories,
  upstreamSettingsOf,
  type AutomationProbe,
} from "../automation-wiring.js";
import {
  checkBrowser,
  defaultBrowserInstallDeps,
  installBrowser,
  sha256OfFile,
  type BrowserCheckEnv,
} from "../browser-install.js";
import { daemonState } from "../daemon.js";
import { checkClaudeUserSettings } from "../claude-user-settings.js";
import {
  checkEngine,
  checkHostAuth,
  checkHostBilling,
  checkMergeLevel,
  checkEnvPassthrough,
  checkPrices,
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
import { checkResearchSearch, checkYtDlp, findYtDlp } from "../research-checks.js";
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
  readClaudeUserSettings,
  type LocalSettingsRead,
  type SessionSandboxReport,
} from "../session-sandbox.js";
import { autoResumeTimer, defaultTimerHost } from "../timer.js";
import { readUserConfig, type UserConfigRead } from "../user-config.js";
import { createAdapters } from "../wiring.js";
import { readMergeLevelLedger } from "./merge-level.js";
import type { CommandContext, CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

/** The user config when doctor is given none to read: every default. */
const NO_USER_CONFIG: UserConfigRead = {
  ok: true,
  path: "~/.vtc/config.yaml",
  config: { version: 1, env_passthrough: [] },
};

const MARK = { ok: "ok  ", info: "info", warn: "warn", fail: "FAIL" } as const;

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
  /** The user's Claude `settings.json`, whose hooks and plugins headless role runs load (D-bp). */
  readonly claudeUserSettings?: () => LocalSettingsRead;
  /** The user's own yt-dlp for YouTube transcripts, `null` when absent (D-bs). */
  readonly ytDlp?: () => Promise<string | null>;
  /** The environment the research search key is read from (H-3). Default: none set. */
  readonly researchEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Automation (AD-27): this machine's gh, login, ffmpeg and origin remote, and the `project.yaml`
   * settings of the VTC repo doctor runs in (`null` outside one; throws when it does not load).
   */
  readonly automation?: {
    readonly probe: () => Promise<AutomationProbe>;
    readonly project: () => Promise<Pick<ProjectConfig, "upstream" | "automation"> | null>;
    /** This build has the gate runner's evidence recorder (merge note); absent: not reported. */
    readonly recorder?: boolean;
    /** What is at `upstream.checkout` (D-by); absent: not checked. */
    readonly checkout?: (path: string) => Promise<CheckoutFacts>;
  };
  /** Each adapter's `capabilities.safeHostWeb` (D-cf). */
  readonly hostWeb?: () => Promise<Readonly<Partial<Record<HostId, boolean>>>>;
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

/** Constructs the adapters only to ask them; no plugin is extracted or installed. */
const withAdapters = async <T>(
  vtcHome: string,
  ask: (adapters: Partial<Record<HostId, HostAdapter>>) => Promise<T>,
): Promise<T> => {
  const adapters = createAdapters(ADAPTER_FACTORIES, {
    vtcHome,
    pluginDir: (host, home) => join(home, "plugins", "doctor", host),
  });
  try {
    return await ask(adapters);
  } finally {
    await Promise.allSettled(Object.values(adapters).map((a) => a.dispose()));
  }
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
    hostAuth: () => withAdapters(ctx.vtcHome, (a) => gatherHostAuth(a, () => new Date())),
    hostWeb: () =>
      withAdapters(ctx.vtcHome, (adapters) =>
        Promise.resolve(
          Object.fromEntries(
            Object.entries(adapters).map(([host, a]) => [
              host,
              a.capabilities.safeHostWeb === true,
            ]),
          ),
        ),
      ),
    automation: {
      probe: async () =>
        probeAutomation(exec, {
          repoRoot: await findRepoRoot(ctx.cwd),
          login: true,
          // gh and ffmpeg run by name outside the repo (a repo could ship an ffmpeg.exe)
          cwd: existsSync(ctx.vtcHome) ? ctx.vtcHome : homedir(),
        }),
      recorder: shippedAutomationFactories().evidence !== undefined,
      checkout: (path) => inspectCheckout(exec, path),
      project: async () => {
        const repoRoot = await findRepoRoot(ctx.cwd);
        return repoRoot === null || !isVtcProject(repoRoot)
          ? null
          : core.loadProjectConfig(repoRoot);
      },
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
    claudeUserSettings: () => {
      const { userSettings } = defaultSessionSandboxEnv();
      return userSettings === null
        ? { kind: "absent", path: "~/.claude/settings.json" }
        : readClaudeUserSettings(userSettings);
    },
    ytDlp: async () =>
      findYtDlp({ pathEnv: process.env.PATH ?? "", repoRoot: await findRepoRoot(ctx.cwd) }),
    researchEnv: process.env,
  };
};

export const createDoctorCommand = (
  env: (ctx: CommandContext) => DoctorCommandEnv = defaultDoctorEnv,
): CommandSpec => ({
  name: "doctor",
  summary:
    "Check prerequisites (runtime, git, host CLIs, versions, logins and billing, gh and its login, automation and evidence (gh --attach, ffmpeg, browser), host web search, auto-resume timer, the user hooks and plugins role runs load, env passthrough, research search and yt-dlp, gate sandbox, session sandbox, the repo's engine and merge level, the browser, pinned scanners, osv database); --download fetches missing scanners and the osv database; --install-browser installs the visual stack's browser",
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
      const statuses = e.hostAuth === undefined ? null : await e.hostAuth();
      if (statuses !== null) {
        const auth = checkHostAuth(statuses);
        if (auth !== null) checks.push(auth);
        const billing = checkHostBilling(statuses);
        if (billing !== null) checks.push(billing);
        const provider = checkProviderBilling(statuses);
        if (provider !== null) checks.push(provider);
      }
      if (e.claudeUserSettings !== undefined)
        checks.push(...checkClaudeUserSettings(e.claudeUserSettings()));
      const userConfig = e.userConfig?.() ?? null;
      if (userConfig !== null) checks.push(checkEnvPassthrough(userConfig));
      const prices = userConfig === null ? null : checkPrices(userConfig);
      if (prices !== null) checks.push(prices);
      const search =
        userConfig === null ? null : checkResearchSearch(userConfig, e.researchEnv ?? {});
      if (search !== null) checks.push(search);
      if (e.ytDlp !== undefined) checks.push(checkYtDlp(await e.ytDlp()));
      if (e.gateSandbox !== undefined)
        checks.push(checkGateSandbox(await e.gateSandbox(), userConfig));
      const session = e.sessionSandbox === undefined ? null : await e.sessionSandbox();
      if (session !== null) checks.push(checkSessionSandbox(session));
      const browser = e.browser === undefined ? null : await checkBrowser(e.browser);
      if (browser !== null) checks.push(browser);
      if (e.automation !== undefined) {
        const probe = await e.automation.probe();
        const login = checkGhLogin(probe);
        if (login !== null) checks.push(login);
        const user = userConfig ?? NO_USER_CONFIG;
        checks.push(
          checkEvidence(probe, requestedHostingOf(user), browser, e.automation.recorder ?? true),
        );
        checks.push(checkFfmpeg(probe.ffmpeg));
        const upstream = upstreamSettingsOf(user);
        if (upstream.checkout !== undefined && e.automation.checkout !== undefined)
          checks.push(
            checkUpstreamCheckout(
              upstream.repo,
              upstream.checkout,
              await e.automation.checkout(upstream.checkout),
            ),
          );
        try {
          const project = await e.automation.project();
          if (project !== null) checks.push(checkAutomation(probe, user, project));
        } catch (error) {
          checks.push({
            name: "automation",
            status: "fail",
            detail: `cannot read the project's settings: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (e.hostWeb !== undefined) checks.push(checkHostWeb(statuses ?? [], await e.hostWeb()));
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
