/**
 * `vtc doctor` prerequisite checks (§4.4), and the auto-resume timer (§6.9 step 4; launchd on
 * macOS, systemd on Linux, `timer.ts`). The pinned scanners are checked in `scanner-checks.ts`. Host logins are read only through the hosts' own
 * status commands (`claude auth status --json`, `codex login status`); VTC never reads a
 * credential file or the keychain (AD-9). Account details the status commands print (email,
 * organisation) are never echoed.
 */
import type { DaemonState } from "./daemon.js";
import type { Exec } from "./process.js";

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
  /** The auto-resume timer's state; the check is skipped when absent (no timer on this OS). */
  readonly timer?: TimerEnv;
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

/** Claude Code: on PATH, and logged in per `claude auth status --json` (`loggedIn`). */
export const checkClaude = async (exec: Exec): Promise<DoctorCheck> => {
  const version = await present(exec, "claude");
  if (version === null)
    return { name: "claude-code", status: "fail", detail: "claude is not on PATH" };
  const status = await exec("claude", ["auth", "status", "--json"], { timeoutMs: 20_000 });
  let loggedIn: boolean;
  let method: string | undefined;
  try {
    const parsed = JSON.parse(status.stdout) as { loggedIn?: unknown; authMethod?: unknown };
    loggedIn = parsed.loggedIn === true;
    method = typeof parsed.authMethod === "string" ? parsed.authMethod : undefined;
  } catch {
    loggedIn = false;
  }
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
  const timer = env.timer === undefined ? null : checkAutoResume(env.timer);
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
 * checksum, into `~/.vtc/`). This build does not provision it yet; the check keeps the gap
 * visible until the Visual QA layer ships its pin.
 */
export const checkChromium = (): DoctorCheck => ({
  name: "chromium",
  status: "warn",
  detail:
    "Playwright's Chromium (Visual QA screenshots) is not provisioned by this vtc build yet; UI runs skip what needs it",
});
