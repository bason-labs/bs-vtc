/**
 * `vtc doctor` prerequisite checks (§4.4), the auto-resume timer (§6.9 step 4; launchd on macOS,
 * systemd on Linux, `timer.ts`, none on Windows in v1), the daemon's `env_passthrough` (D-ak),
 * the gate sandbox (D-al) and the repo's Claude session sandbox (D-an). The pinned scanners are
 * checked in `scanner-checks.ts`. Host logins are read only through the hosts' own
 * status commands (`claude auth status --json`, `codex login status`); VTC never reads a
 * credential file or the keychain (AD-9). Account details the status commands print (email,
 * organisation) are never echoed.
 */
import { GATE_SANDBOX, type GateSandboxKind } from "@vtc/shared";
import type { DaemonState } from "./daemon.js";
import type { Exec } from "./process.js";
import type { SessionSandboxReport } from "./session-sandbox.js";
import { allowUnsandboxedOf, type UserConfigRead } from "./user-config.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** Oldest Node that runs VTC in development (`.nvmrc`, AD-2 rule 1). */
export const MIN_NODE = [22, 13] as const;

export interface DoctorEnv {
  readonly exec: Exec;
  /** `process.versions`: `bun` is set inside the binary, `node` always. */
  readonly versions: Readonly<Record<string, string | undefined>>;
  /**
   * The auto-resume timer's state; `"unsupported"` on a platform with no timer in v1 (Windows,
   * D-aj, spine §5 reading 56), which doctor explains; the check is skipped when absent.
   */
  readonly timer?: TimerEnv | "unsupported";
}

/** What the auto-resume check reads (§6.9 step 4). */
export interface TimerEnv {
  /** "launchd timer" or "systemd timer" (`AutoResumeTimer.kind`). */
  readonly kind: string;
  /** The installed timer's file (plist, service unit), or `null` when none is installed. */
  readonly read: () => string | null;
  /** The program that file runs (`AutoResumeTimer.program`). */
  readonly program: (text: string) => string | null;
  readonly exists: (path: string) => boolean;
  /** The persisted wake-ups (`~/.vtc/wake/`). */
  readonly wakeups: () => readonly { readonly repo_root: string; readonly at: string }[];
}

/**
 * The auto-resume timer: installed, and pointing at a `vtc` that still exists (an upgrade can
 * move the binary). A missing timer is a warning, louder when a run already waits on it.
 */
export const checkAutoResume = (env: TimerEnv): DoctorCheck => {
  const name = "auto-resume";
  const fix = "run vtc install --auto-resume";
  const text = env.read();
  if (text === null) {
    const [waiting] = env.wakeups();
    return {
      name,
      status: "warn",
      detail:
        waiting === undefined
          ? `the ${env.kind} is not installed, so a run parked on a usage limit resumes only when its engine runs: ${fix}`
          : `a run in ${waiting.repo_root} waits to auto-resume at ${waiting.at}, but the ${env.kind} is not installed: ${fix}`,
    };
  }
  const program = env.program(text);
  if (program === null || !env.exists(program))
    return {
      name,
      status: "warn",
      detail: `the ${env.kind} runs ${program ?? "nothing"}, which no longer exists: ${fix}`,
    };
  return { name, status: "ok", detail: `${env.kind} installed (${program})` };
};

/** Windows in v1 (D-aj, spine §5 reading 56): no timer; resume waits for the engine. */
export const NO_TIMER_CHECK: DoctorCheck = {
  name: "auto-resume",
  status: "warn",
  detail:
    "no auto-resume timer on this platform in v1: a run parked on a usage limit resumes when its engine next runs on that repo",
};

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? "";

export const checkRuntime = (versions: DoctorEnv["versions"]): DoctorCheck => {
  if (versions.bun !== undefined)
    return { name: "runtime", status: "ok", detail: `bun ${versions.bun}` };
  const [major = 0, minor = 0] = (versions.node ?? "0.0").split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    name: "runtime",
    status: ok ? "ok" : "fail",
    detail: ok
      ? `node ${versions.node ?? "?"}`
      : `node ${versions.node ?? "?"}: VTC needs node >= ${MIN_NODE.join(".")}`,
  };
};

const present = async (exec: Exec, command: string): Promise<string | null> => {
  const result = await exec(command, ["--version"], { timeoutMs: 15_000 });
  return result.code === 0 ? firstLine(result.stdout) || command : null;
};

export const checkGit = async (exec: Exec): Promise<DoctorCheck> => {
  const version = await present(exec, "git");
  return version === null
    ? { name: "git", status: "fail", detail: "git is not on PATH" }
    : { name: "git", status: "ok", detail: version };
};

export const checkGh = async (exec: Exec): Promise<DoctorCheck> => {
  const version = await present(exec, "gh");
  return version === null
    ? {
        name: "gh",
        status: "warn",
        detail: "gh is not on PATH: merge levels 2 and 3 (push and PR) need it",
      }
    : { name: "gh", status: "ok", detail: version };
};

/**
 * Claude Code: on PATH, and logged in per `claude auth status --json` (`loggedIn`). An
 * `apiKeyHelper` setup (named by its `authMethod` or `apiKeySource`) is a warning (D-ab, spine §5
 * reading 48): role runs ignore user settings, where the helper lives, so VTC runs need the
 * user's own subscription login. Nothing but that status command is consulted (AD-9).
 */
export const checkClaude = async (exec: Exec): Promise<DoctorCheck> => {
  const version = await present(exec, "claude");
  if (version === null)
    return { name: "claude-code", status: "fail", detail: "claude is not on PATH" };
  const status = await exec("claude", ["auth", "status", "--json"], { timeoutMs: 20_000 });
  let loggedIn: boolean;
  let method: string | undefined;
  let helper = false;
  try {
    const parsed = JSON.parse(status.stdout) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      apiKeySource?: unknown;
    };
    loggedIn = parsed.loggedIn === true;
    method = typeof parsed.authMethod === "string" ? parsed.authMethod : undefined;
    helper = [parsed.authMethod, parsed.apiKeySource].some(
      (v) => typeof v === "string" && /apikeyhelper/i.test(v),
    );
  } catch {
    loggedIn = false;
  }
  if (helper)
    return {
      name: "claude-code",
      status: "warn",
      detail: `${version}: an apiKeyHelper setup is out of scope for v1 (role runs ignore user settings, where the helper lives): log in with your Claude subscription (run claude, then /login)`,
    };
  return loggedIn
    ? {
        name: "claude-code",
        status: "ok",
        detail: `${version}, logged in${method === undefined ? "" : ` (${method})`}`,
      }
    : { name: "claude-code", status: "fail", detail: `${version}, not logged in: run claude` };
};

/** Codex: on PATH, and logged in per `codex login status` (exit 0). */
export const checkCodex = async (exec: Exec): Promise<DoctorCheck> => {
  const version = await present(exec, "codex");
  if (version === null) return { name: "codex", status: "fail", detail: "codex is not on PATH" };
  const status = await exec("codex", ["login", "status"], { timeoutMs: 20_000 });
  return status.code === 0
    ? { name: "codex", status: "ok", detail: `${version}, logged in` }
    : { name: "codex", status: "fail", detail: `${version}, not logged in: run codex login` };
};

/**
 * Every check. One usable host is enough: when the other host is missing or logged out, its
 * check is downgraded to a warning.
 */
export const runDoctorChecks = async (env: DoctorEnv): Promise<DoctorCheck[]> => {
  const [git, gh, claude, codex] = await Promise.all([
    checkGit(env.exec),
    checkGh(env.exec),
    checkClaude(env.exec),
    checkCodex(env.exec),
  ]);
  const hosts = [claude, codex];
  const anyHost = hosts.some((h) => h.status === "ok");
  const timer =
    env.timer === undefined
      ? null
      : env.timer === "unsupported"
        ? NO_TIMER_CHECK
        : checkAutoResume(env.timer);
  return [
    checkRuntime(env.versions),
    git,
    ...hosts.map((h) => (anyHost && h.status === "fail" ? { ...h, status: "warn" as const } : h)),
    gh,
    ...(timer === null ? [] : [timer]),
  ];
};

/**
 * The repo's running engine, when doctor runs in a repo: a daemon that refuses this `vtc` (e.g.
 * one an upgrade left running with a different contracts MAJOR) fails, since every bridge and
 * control command would fail until it is stopped. No running daemon is no check.
 */
export const checkEngine = (repoRoot: string, found: DaemonState): DoctorCheck | null => {
  switch (found.state) {
    case "absent":
      return null;
    case "live":
      return {
        name: "engine",
        status: "ok",
        detail: `running for ${repoRoot} (pid ${String(found.record.pid)}, ${found.record.engine_version})`,
      };
    case "refused":
      return {
        name: "engine",
        status: "fail",
        detail: `the engine running for ${repoRoot} (pid ${String(found.record.pid)}, ${found.record.engine_version}) refuses this vtc (${found.error}): run vtc engine --stop in that repo`,
      };
  }
};

/**
 * Playwright's Chromium for Visual QA (§4.4: downloaded on demand by `vtc doctor`, pinned by
 * checksum, into `~/.vtc/`). The pin is deferred until Visual QA has a consumer (D-ai, spine §5
 * reading 55: Playwright's CDN publishes no SHA-256, so the pin will be the hash of a reviewed
 * download); until then doctor only warns.
 */
export const checkChromium = (): DoctorCheck => ({
  name: "chromium",
  status: "warn",
  detail:
    "Playwright's Chromium (Visual QA screenshots) is not provisioned: its pin is deferred until Visual QA has a consumer; UI runs skip what needs it",
});

/**
 * Which credential variables reach the detached daemon (D-ak, spine §5 reading 57): it drops
 * them unless `~/.vtc/config.yaml` lists their names in `env_passthrough`. Names only, never
 * values. A file that does not parse fails the check (nothing passes until it is fixed).
 */
export const checkEnvPassthrough = (read: UserConfigRead): DoctorCheck => {
  if (!read.ok)
    return {
      name: "env",
      status: "fail",
      detail: `${read.path} does not parse (${read.error}); the detached daemon passes no credential variables until it does`,
    };
  const names = read.config.env_passthrough;
  return {
    name: "env",
    status: "ok",
    detail:
      names.length === 0
        ? `the detached daemon drops credential variables; none pass (env_passthrough in ${read.path})`
        : `passes ${names.join(", ")} to the detached daemon (env_passthrough in ${read.path})`,
  };
};

/** Where macOS ships `sandbox-exec`. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The OS sandbox gate commands can run in on this machine (D-al, spine §5 reading 69):
 * `sandbox-exec` on macOS, `bwrap` (bubblewrap) on Linux, `null` when there is none. A presence
 * probe only (`bwrap --version`); the Gate Runner detects and uses its own when it runs gates.
 */
export const detectGateSandbox = async (
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  exec: Exec,
): Promise<Exclude<GateSandboxKind, "none"> | null> => {
  if (platform === "darwin") return exists(SANDBOX_EXEC) ? "sandbox-exec" : null;
  if (platform === "linux")
    return (await exec("bwrap", ["--version"], { timeoutMs: 10_000 })).code === 0 ? "bwrap" : null;
  return null;
};

/**
 * Which sandbox gate commands run in. None and no opt-in fails: every gate run parks (`infra`,
 * `GATE_SANDBOX.noSandboxReason`). The user-level opt-in `gates.allow_unsandboxed` always warns.
 */
export const checkGateSandbox = (
  kind: Exclude<GateSandboxKind, "none"> | null,
  config: UserConfigRead | null,
): DoctorCheck => {
  const name = "gate sandbox";
  const optIn = config !== null && allowUnsandboxedOf(config);
  const where = config?.path ?? "~/.vtc/config.yaml";
  if (kind !== null)
    return optIn
      ? {
          name,
          status: "warn",
          detail: `gate commands run in ${kind}; gates.allow_unsandboxed is on in ${where}, so they would run unconfined if ${kind} went missing: remove it`,
        }
      : { name, status: "ok", detail: `gate commands run in ${kind}` };
  return optIn
    ? {
        name,
        status: "warn",
        detail: `${GATE_SANDBOX.noSandboxReason}: gates run unconfined (gates.allow_unsandboxed in ${where}), and every gate run records an unsandboxed_gate incident`,
      }
    : {
        name,
        status: "fail",
        detail: `${GATE_SANDBOX.noSandboxReason}: every gate run parks until there is one (macOS: sandbox-exec; Linux: install bubblewrap). To run gates unconfined instead, set gates.allow_unsandboxed: true in ${where}`,
      };
};

/**
 * The repo's Claude Code session sandbox (D-an, spine §5 reading 71): in plugin-only dispatch
 * the engine runs code-running roles in a Claude Code Lead session only when it is on. A warning
 * otherwise (Codex-only users and headless dispatch do not need it).
 */
export const checkSessionSandbox = (report: SessionSandboxReport): DoctorCheck => {
  const name = "session";
  const fix = "run vtc install --host claude-code in this repo";
  if (report.state === "on")
    return { name, status: "ok", detail: `the Claude session sandbox is on (${report.path})` };
  const refused = "code-running roles are refused in a Claude Code session";
  switch (report.file) {
    case "absent":
      return {
        name,
        status: "warn",
        detail: `no Claude session sandbox in ${report.path}: ${refused}; ${fix}`,
      };
    case "unreadable":
      return {
        name,
        status: "warn",
        detail: `${report.path} cannot be read (not a plain JSON file): ${refused}; fix or remove it, then ${fix}`,
      };
    case "ok":
      return {
        name,
        status: "warn",
        detail: `the Claude session sandbox in ${report.path} is off; missing: ${report.missing.join(", ")}: ${refused}; ${fix}`,
      };
  }
};
