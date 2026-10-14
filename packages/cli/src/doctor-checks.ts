/**
 * `vtc doctor` prerequisite checks (§4.4), the auto-resume timer (§6.9 step 4; launchd on macOS,
 * systemd on Linux, `timer.ts`, none on Windows in v1), the daemon's `env_passthrough` (D-ak),
 * the gate sandbox (D-al) and the repo's Claude session sandbox (D-an). The pinned scanners are
 * checked in `scanner-checks.ts`. Host logins are read only through the hosts' own
 * status commands (`claude auth status --json`, `codex login status`); VTC never reads a
 * credential file or the keychain (AD-9). Account details the status commands print (email,
 * organisation) are never echoed.
 */
import { gates } from "@vtc/engine";
import {
  API_KEY_BILLING_WARNING,
  effectiveMergeLevel,
  GATE_SANDBOX,
  level3Preflight,
  type HostAuthStatus,
  type MergeLevel,
  type MergeLevelLedgerEntry,
  type MergePreflightFailure,
  type RemoteInfo,
  type RemoteMergePolicy,
} from "@vtc/shared";
import type { DaemonState } from "./daemon.js";
import type { Exec } from "./process.js";
import type { SessionSandboxReport } from "./session-sandbox.js";
import { allowUnsandboxedOf, type UserConfigRead } from "./user-config.js";

/**
 * `info` reports something the user should know that needs no action and fails nothing (an
 * accepted residual, an optional tool that is absent).
 */
export type CheckStatus = "ok" | "info" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/**
 * Oldest Node that runs VTC in development (`.nvmrc`, AD-2 rule 1): 22.14, for the visual
 * runner's `--disable-sigusr1` (D-bk, spine §5 reading 165).
 */
export const MIN_NODE = [22, 14] as const;

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
  return {
    name,
    status: "ok",
    detail: `${env.kind} installed (${program}); it wakes the engine, and a waiting run continues when the Lead session calls next`,
  };
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
 * `apiKeyHelper` setup (named by its `authMethod` or `apiKeySource`) warns with
 * `API_KEY_BILLING_WARNING` (D-ab, D-bq; spine §5 readings 108, 130 and 171): headless role runs
 * load the user's settings, so the helper bills them to the API key rather than the subscription
 * login VTC is built for. Role runs are allowed; doctor does not fail on it. Nothing but that
 * status command is consulted (AD-9).
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
      detail: `${version}: ${API_KEY_BILLING_WARNING} (an apiKeyHelper in your user settings, which headless role runs load). Role runs still run; to bill your subscription instead, remove apiKeyHelper and log in (run claude, then /login)`,
    };
  return loggedIn
    ? withClaudeMinimum(
        {
          name: "claude-code",
          status: "ok",
          detail: `${version}, logged in${method === undefined ? "" : ` (${method})`}`,
        },
        version,
      )
    : { name: "claude-code", status: "fail", detail: `${version}, not logged in: run claude` };
};

/**
 * The oldest Claude Code VTC's headless argv works with: `--permission-prompts none` (AD-25
 * rule 1) arrived in 2.1.259.
 */
export const CLAUDE_MIN_VERSION = "2.1.259";

/** `[major, minor, patch]` of the first `x.y.z` in a `--version` line, or `null`. */
export const parseVersion = (text: string): [number, number, number] | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** `a < b` for parsed versions. */
const older = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

/** Whether the first `x.y.z` in a `--version` line is at least `min`; `false` when none is found. */
export const versionAtLeast = (versionLine: string, min: string): boolean => {
  const found = parseVersion(versionLine);
  const floor = parseVersion(min);
  return found !== null && floor !== null && !older(found, floor);
};

/** The Claude Code check, warning (when it is otherwise ok) below {@link CLAUDE_MIN_VERSION}. */
export const withClaudeMinimum = (check: DoctorCheck, versionLine: string | null): DoctorCheck => {
  const found = versionLine === null ? null : parseVersion(versionLine);
  const min = parseVersion(CLAUDE_MIN_VERSION);
  if (check.status !== "ok" || found === null || min === null || !older(found, min)) return check;
  return {
    ...check,
    status: "warn",
    detail: `${check.detail}; headless Claude runs need Claude Code ${CLAUDE_MIN_VERSION} or later (--permission-prompts): run claude update`,
  };
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

/**
 * The price table (§11, H-1; spine §5 reading 152): Codex reports no cost, so the engine prices
 * an engine-launched Codex run from `prices` in `~/.vtc/config.yaml` and starts none whose model
 * (`hosts.models.codex`) is not priced there. An empty table warns; a file that does not parse is
 * reported by the `env` check.
 */
export const checkPrices = (read: UserConfigRead): DoctorCheck | null => {
  if (!read.ok) return null;
  const models = Object.keys(read.config.prices ?? {}).sort();
  return models.length === 0
    ? {
        name: "prices",
        status: "warn",
        detail: `no model is priced (prices in ${read.path}): Codex reports no cost, so the engine starts no Codex role run (a Codex-led run's roles, a Codex cross-family review) until the model hosts.models.codex names is priced there (§11)`,
      }
    : {
        name: "prices",
        status: "ok",
        detail: `prices ${models.join(", ")} (prices in ${read.path}); a run on any other model of a host that reports no cost does not start`,
      };
};

/** What `vtc doctor` reports about the gate sandbox: the Gate Runner's own detection. */
export type GateSandboxReport = Pick<
  gates.GateSandboxDetection,
  "kind" | "detail" | "reason" | "warning"
>;

/**
 * The OS sandbox gate commands run in on this machine (D-al, spine §5 reading 69). This is the
 * Gate Runner's `gates.detectGateSandbox` itself (the same tools, the same confined no-op probes,
 * bwrap and pasta on Linux), so doctor never reports a sandbox the gate runs would not find.
 * Tests inject `platform`, `exists`, `env` and `probe`.
 */
export const detectGateSandbox = (
  options: gates.DetectGateSandboxOptions = {},
): GateSandboxReport => {
  const { kind, detail, reason, warning } = gates.detectGateSandbox(options);
  return {
    kind,
    detail,
    ...(reason === undefined ? {} : { reason }),
    ...(warning === undefined ? {} : { warning }),
  };
};

/**
 * Which sandbox gate commands run in. None and no opt-in fails: every gate run parks (`infra`,
 * `GATE_SANDBOX.noSandboxReason`). The user-level opt-in `gates.allow_unsandboxed` always warns.
 */
export const checkGateSandbox = (
  found: GateSandboxReport,
  config: UserConfigRead | null,
): DoctorCheck => {
  const { kind } = found;
  const name = "gate sandbox";
  const optIn = config !== null && allowUnsandboxedOf(config);
  const where = config?.path ?? "~/.vtc/config.yaml";
  if (kind !== null && found.warning !== undefined && !optIn)
    // D-aw: Linux without pasta runs verify-phase gates; install-phase ones park as infra
    return {
      name,
      status: "warn",
      detail: `gate commands run in ${found.detail}: ${found.warning}`,
    };
  if (kind !== null)
    return optIn
      ? {
          name,
          status: "warn",
          detail: `gate commands run in ${kind}; gates.allow_unsandboxed is on in ${where}, so they would run unconfined if ${kind} went missing: remove it`,
        }
      : { name, status: "ok", detail: `gate commands run in ${found.detail}` };
  const why = found.reason === undefined ? "" : ` (${found.reason})`;
  return optIn
    ? {
        name,
        status: "warn",
        detail: `${GATE_SANDBOX.noSandboxReason}${why}: gates run unconfined (gates.allow_unsandboxed in ${where}), and every gate run records an unsandboxed_gate incident`,
      }
    : {
        name,
        status: "fail",
        detail: `${GATE_SANDBOX.noSandboxReason}${why}: every gate run parks until there is one (macOS: sandbox-exec; Linux: bubblewrap with unprivileged user namespaces, and pasta from passt). To run gates unconfined instead, set gates.allow_unsandboxed: true in ${where}`,
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
  const widened =
    report.widening.length === 0
      ? ""
      : `; these settings let commands past it: ${report.widening.join("; ")} (remove them)`;
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
      if (report.missing.length === 0 && report.widening.length === 0)
        return {
          name,
          status: "warn",
          detail: `Claude Code cannot sandbox commands on this machine (missing: ${report.unavailable.join(", ")}): ${refused}`,
        };
      return {
        name,
        status: "warn",
        detail: `the Claude session sandbox in ${report.path} is ${report.state}${report.missing.length === 0 ? "" : `; missing: ${report.missing.join(", ")}`}${widened}: ${refused}; ${fix}`,
      };
  }
};

/**
 * What each host adapter's `authStatus()` reports (AD-25 rule 3): the check the engine runs
 * before every unattended start or resume, through the host's own status command. Hosts whose
 * adapter has no such command are left out; none at all is no check.
 */
export const checkHostAuth = (statuses: readonly HostAuthStatus[]): DoctorCheck | null => {
  if (statuses.length === 0) return null;
  const parts = statuses.map((s) =>
    s.logged_in === true
      ? `${s.host} logged in${s.method === null ? "" : ` (${s.method})`}`
      : s.logged_in === false
        ? `${s.host} not logged in`
        : `${s.host} unknown (its status command did not run)`,
  );
  const anyIn = statuses.some((s) => s.logged_in === true);
  return {
    name: "host auth",
    status: anyIn ? "ok" : "warn",
    detail: `${parts.join("; ")}${anyIn ? "" : ": an unattended run parks with auth until you log in"}`,
  };
};

/**
 * API-key billing (D-bq, spine §5 reading 171): each host whose `authStatus()` reports
 * `billing: "api_key"` warns with `API_KEY_BILLING_WARNING`, the same text Flow Studio shows. Role
 * runs on it are not refused, so this never fails doctor. `null` when no host bills a key.
 */
export const checkHostBilling = (statuses: readonly HostAuthStatus[]): DoctorCheck | null => {
  const keyed = statuses.filter((s) => s.billing === "api_key").map((s) => s.host);
  if (keyed.length === 0) return null;
  return {
    name: "billing",
    status: "warn",
    detail: `${keyed.join(", ")}: ${API_KEY_BILLING_WARNING}. Role runs still run; to bill your subscription instead, log ${keyed.join(" and ")} in with it`,
  };
};

/** What the merge-level check reads (AD-23 rule 1). */
export interface MergeLevelEnv {
  /** `project.yaml` `merge_level`. */
  readonly configured: MergeLevel;
  /** The git-tracked downgrade ledger (`.vtc/merge-level.jsonl`). */
  readonly ledger: readonly Pick<MergeLevelLedgerEntry, "kind" | "cap">[];
  /** The base branch Level 3 merges into. */
  readonly base: string;
  readonly remote: () => Promise<RemoteInfo>;
  /** Throws when the remote cannot be read. */
  readonly policy: (base: string) => Promise<RemoteMergePolicy>;
}

const PREFLIGHT_FIX: Readonly<Record<MergePreflightFailure, (base: string) => string>> = {
  not_github: () => "the origin remote is not on GitHub (Level 3 is GitHub-only)",
  gh_unauthenticated: () => "gh is not logged in (run gh auth login)",
  auto_merge_disallowed: () => "allow auto-merge in the repository settings",
  no_required_checks: (base) =>
    `add at least one required status check on ${base} (a ruleset or branch protection), or GitHub would merge without CI`,
  no_merge_method: () =>
    "allow at least one merge method (or your access cannot read the repository settings)",
  no_merge_service: () => "this engine has no GitHub merge service (gh) wired in",
};

/**
 * The merge level (AD-23 rules 1 and 5): what `project.yaml` asks for, what the ledger caps it at,
 * and with Level 3 the same `level3Preflight` the engine runs at run start. VTC never changes a
 * repository setting; a failed preflight warns with what to configure, because runs then start at
 * Level 2.
 */
export const checkMergeLevel = async (env: MergeLevelEnv): Promise<DoctorCheck> => {
  const name = "merge level";
  const cap = effectiveMergeLevel(3, env.ledger);
  const effective = effectiveMergeLevel(env.configured, env.ledger);
  const capped =
    effective < env.configured
      ? `; the ledger caps it at ${String(cap)} after a downgrade (vtc merge-level restore)`
      : "";
  if (env.configured < 3)
    return { name, status: "ok", detail: `level ${String(effective)}${capped}` };
  const remote = await env.remote();
  let policy: RemoteMergePolicy | null = null;
  if (remote.github && remote.ghAuthenticated) {
    try {
      policy = await env.policy(env.base);
    } catch {
      policy = null;
    }
  }
  const failed = level3Preflight({ ...remote, policy });
  if (failed.length > 0)
    return {
      name,
      status: "warn",
      detail: `project.yaml asks for level 3, but runs start at level 2: ${failed.map((f) => PREFLIGHT_FIX[f](env.base)).join("; ")}`,
    };
  return {
    name,
    status: effective === 3 ? "ok" : "warn",
    detail: `level 3 preflight passes on ${env.base} (required checks: ${policy?.required_checks.join(", ") ?? ""})${capped}`,
  };
};
