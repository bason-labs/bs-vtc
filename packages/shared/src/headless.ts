/**
 * Engine-launched headless role runs (spec §6.9, §12; spine AD-17, AD-25; Lead decision D-ba,
 * human decision H-1). New in contracts 4.5.0.
 *
 * - Routing: `planDispatch` (helpers/dispatch.ts) stays the only decision. Which way a run's roles
 *   go by default depends on the host the run's Lead session is in, and that default is one
 *   constant here, {@link ROLE_DISPATCH_BY_LEAD_HOST} (H-1: a Codex Lead's roles run as headless
 *   Codex runs the engine launches; a Claude Code Lead keeps plugin-only subagents).
 * - Hardening: the argv an adapter builds must isolate the repo's own host settings and MCP
 *   servers, deny every prompt nobody can answer, and never carry a flag that drops the user's
 *   login or approves on the user's behalf ({@link HOST_DISALLOWED_ARGS},
 *   {@link headlessIsolationGaps}). The adapter safety contract asserts both.
 * - Supervision: process-group timeouts ({@link HeadlessPolicy}) and an auth preflight
 *   ({@link HostAuthStatusSchema}) before every unattended start or resume.
 */
import { z } from "zod";
import {
  HostIdSchema,
  IsoDateTimeSchema,
  RoleIdSchema,
  SessionRefSchema,
  SlugSchema,
  TaskIdSchema,
  type HostId,
} from "./primitives.js";

// ------------------------------------------------------------------ routing

/**
 * How the roles of a run go by default, keyed by the host of the run's Lead session (H-1,
 * 2026-10-14):
 * - `claude-code`: `subagent`. The Lead dispatches role subagents in its own session (plugin-only,
 *   the default the human chose at G2). Headless Claude runs still need `hosts.dispatch:
 *   headless_allowed`.
 * - `codex`: `headless`. A Codex Lead cannot run roles in-session (spine §5 reading 82), so the
 *   engine runs that run's roles itself as headless Codex runs through `HostAdapter.spawnRole`,
 *   sandboxed and budget-checked, without the `headless_allowed` opt-in.
 *
 * Changing either answer is a one-value change here; `planDispatch` reads it.
 */
export const ROLE_DISPATCH_BY_LEAD_HOST: Readonly<Record<HostId, "subagent" | "headless">> = {
  "claude-code": "subagent",
  codex: "headless",
};

// -------------------------------------------------------------- supervision

/** Defaults of {@link HeadlessPolicy}; `project.yaml` `hosts.headless` overrides the two timeouts. */
export const HEADLESS_DEFAULTS = {
  /** Hard wall-clock limit of one headless run, in minutes. */
  wallTimeoutMin: 60,
  /** No stdout line for this long ends the run, in minutes. */
  idleTimeoutMin: 10,
  /** After SIGINT to the process group, wait this long before SIGTERM. */
  interruptGraceMs: 10_000,
  /** After SIGTERM, wait this long before SIGKILL. */
  termGraceMs: 5_000,
  /**
   * `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` the Claude adapter sets explicitly, so a `-p` run never
   * waits the host's default 10 minutes for background work.
   */
  claudeBackgroundWaitMs: 120_000,
} as const;

/**
 * How the launcher supervises one headless run (AD-25 rule 4): the child starts in its own process
 * group; the run ends at `wallTimeoutMs`, or after `idleTimeoutMs` without a stdout line; shutdown
 * is SIGINT to the group, then SIGTERM after `interruptGraceMs`, then SIGKILL after `termGraceMs`.
 * No orphans (§15). The outcome is `error` with `cause` `timeout`, `idle` or `killed`.
 */
export interface HeadlessPolicy {
  readonly wallTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly interruptGraceMs: number;
  readonly termGraceMs: number;
}

/** `project.yaml` `hosts.headless` (optional; absent = {@link HEADLESS_DEFAULTS}). */
export const HeadlessConfigSchema = z.strictObject({
  wall_timeout_min: z.int().min(1).max(720).optional(),
  idle_timeout_min: z.int().min(1).max(120).optional(),
});
export type HeadlessConfig = z.infer<typeof HeadlessConfigSchema>;

/** Pure: the supervision policy for a project's `hosts.headless` section. */
export const headlessPolicyFor = (headless: HeadlessConfig | undefined): HeadlessPolicy => ({
  wallTimeoutMs: (headless?.wall_timeout_min ?? HEADLESS_DEFAULTS.wallTimeoutMin) * 60_000,
  idleTimeoutMs: (headless?.idle_timeout_min ?? HEADLESS_DEFAULTS.idleTimeoutMin) * 60_000,
  interruptGraceMs: HEADLESS_DEFAULTS.interruptGraceMs,
  termGraceMs: HEADLESS_DEFAULTS.termGraceMs,
});

/**
 * Why a headless run ended in `error` (`HostOutcome` `error.cause`): the wall timeout, the idle
 * timeout, a kill (exit 143 after SIGTERM, or `vtc pause`), the host's turn cap, its budget cap, a
 * non-zero exit with no terminal stream event, or a process that never started.
 */
export const HostErrorCauseSchema = z.enum([
  "timeout",
  "idle",
  "killed",
  "max_turns",
  "budget",
  "exit_code",
  "spawn",
]);
export type HostErrorCause = z.infer<typeof HostErrorCauseSchema>;

// --------------------------------------------------------------------- auth
/**
 * Who pays for a host's role runs (spine §5 reading 171, D-bq). An API-key login is allowed: role
 * runs are not refused, but `vtc doctor` and Flow Studio show {@link API_KEY_BILLING_WARNING}
 * (`HostAuthStatus.billing`, `UsageSnapshot.billing`). New in 4.10.0.
 */
export const HostBillingSchema = z.enum([
  "subscription",
  "api_key",
  /**
   * Billed through a cloud provider or gateway (Amazon Bedrock, Google Vertex AI, Microsoft
   * Foundry, an LLM gateway): the adapter reads it from the status command's provider. Flow Studio
   * and `vtc doctor` show {@link PROVIDER_BILLING_NOTICE}, a neutral notice, not a warning. New in
   * 5.0.0 (D-ci, spine §5 reading 203). A login the status command reports only as an OAuth
   * token (`oauth_token`) is `null` (unknown), never `subscription`.
   */
  "provider",
]);
export type HostBilling = z.infer<typeof HostBillingSchema>;

/** The neutral notice for {@link HostBilling} `provider` (D-ci), in doctor and Flow Studio. */
export const PROVIDER_BILLING_NOTICE = "billed through your cloud provider or gateway";

/** The visible warning for an API-key login (D-bq), the same text in doctor and Flow Studio. */
export const API_KEY_BILLING_WARNING =
  "API-key billing: this host is signed in with an API key, so VTC role runs on it are billed to that key at API prices, not to your subscription";

/**
 * The host's own login state, read only through the host's sanctioned status command
 * (`claude auth status`, `codex login status`): exit 0 = logged in. VTC never reads a credential
 * file (AD-9). `logged_in: null` = the command could not be run; `method` is what the command
 * said (e.g. "claude.ai", "ChatGPT"), never a token.
 */
export const HostAuthStatusSchema = z.strictObject({
  host: HostIdSchema,
  logged_in: z.boolean().nullable(),
  method: z.string().min(1).max(100).nullable(),
  /**
   * Who pays for role runs on this login, as the adapter reads it from the status command
   * (`HostBilling`): `api_key` for an API-key login (Codex "Logged in using an API key"), else
   * `subscription`; absent or `null` when the command does not say. New in 4.10.0 (D-bq).
   */
  billing: HostBillingSchema.nullable().optional(),
  checked_at: IsoDateTimeSchema,
});
export type HostAuthStatus = z.infer<typeof HostAuthStatusSchema>;

/**
 * The checks an engine-driven start or resume passes before it launches anything (AD-25 rule 3,
 * §6.9 steps 5–6), in this order. The first failing one parks the steps (`auth` failures park
 * with an incident and never retry in a loop).
 */
export const AutoResumeCheckSchema = z.enum(["paused", "config", "usage", "auth", "budget"]);
export type AutoResumeCheck = z.infer<typeof AutoResumeCheckSchema>;

/** Payload of the `headless.preflight` event. */
export const HeadlessPreflightSchema = z
  .strictObject({
    host: HostIdSchema,
    /** `auto_resume`: the timer woke the daemon with no live Lead; `role`: a Codex-led run. */
    purpose: z.enum(["role", "auto_resume", "cross_family_review", "lookback_replay"]),
    ok: z.boolean(),
    failed: AutoResumeCheckSchema.optional(),
    detail: z.string().min(1).max(500).optional(),
  })
  .refine((v) => v.ok === (v.failed === undefined), {
    message: "failed names the check exactly when ok is false",
    path: ["failed"],
  });
export type HeadlessPreflight = z.infer<typeof HeadlessPreflightSchema>;

// ----------------------------------------------------------- argv hardening

/**
 * Flags no headless argv may carry, on either host (AD-25 rule 2), matched as a whole argument or
 * as `<flag>=…`:
 * - `--bare` (Claude): never reads the subscription login and needs an API key (AD-9, §12.5);
 * - `--approve-for-me`, `--not-so-yolo` (Codex): an automatic approver decides for the user.
 * The permission-bypass flags themselves are AD-9 markers (`AD9_FORBIDDEN_MARKERS`).
 */
export const HOST_DISALLOWED_ARGS = ["--bare", "--approve-for-me", "--not-so-yolo"] as const;

/** Pure: every argument that is, or sets, a {@link HOST_DISALLOWED_ARGS} flag. */
export const findDisallowedHostArgs = (args: readonly string[]): string[] =>
  args.filter((arg) =>
    HOST_DISALLOWED_ARGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i !== -1) return args[i + 1];
  return args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
};

/**
 * Pure (AD-25 rule 1): which isolation requirements a fresh or resumed headless argv misses;
 * empty when it has them all. The adapter safety contract asserts it is empty for every profile.
 * - Claude Code: `--setting-sources` without `project` or `local` (the repo's committed hooks,
 *   `env` and MCP enablement are untrusted repo content; the user's own settings are the user's
 *   trust domain), `--strict-mcp-config`, `--permission-mode dontAsk`, `--permission-prompts none`.
 * - Codex: `--sandbox read-only` or `workspace-write`, and `-c approval_policy="never"`.
 */
export const headlessIsolationGaps = (host: HostId, args: readonly string[]): string[] => {
  const gaps: string[] = [];
  if (host === "claude-code") {
    const sources = valueAfter(args, "--setting-sources");
    if (sources === undefined) gaps.push("--setting-sources");
    else if (
      sources
        .split(",")
        .map((s) => s.trim())
        .some((s) => s === "project" || s === "local")
    ) {
      gaps.push("--setting-sources without project/local");
    }
    if (!args.includes("--strict-mcp-config")) gaps.push("--strict-mcp-config");
    if (valueAfter(args, "--permission-mode") !== "dontAsk") gaps.push("--permission-mode dontAsk");
    if (valueAfter(args, "--permission-prompts") !== "none") gaps.push("--permission-prompts none");
    return gaps;
  }
  const sandbox = valueAfter(args, "--sandbox");
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    gaps.push("--sandbox read-only|workspace-write");
  }
  const approval = args.some((a, i) => {
    const setting = a.startsWith("-c=") ? a.slice(3) : args[i - 1] === "-c" ? a : null;
    return setting !== null && /^approval_policy\s*=\s*"?never"?$/.test(setting);
  });
  if (!approval) gaps.push('-c approval_policy="never"');
  return gaps;
};

// --------------------------------------------------------------- run events

/** Payload of `headless.started`: the engine launched a role run itself (AD-4 rule 4). */
export const HeadlessStartedSchema = z.strictObject({
  action_id: SlugSchema,
  /** `null` when the platform gave none. */
  pid: z.int().positive().nullable(),
  /** A resume of this session (`HostAdapter.resume`), or `null` for a fresh run. */
  resume: SessionRefSchema.nullable(),
  /** Wall and idle limits applied, in milliseconds. */
  wall_timeout_ms: z.int().positive(),
  idle_timeout_ms: z.int().positive(),
});
export type HeadlessStarted = z.infer<typeof HeadlessStartedSchema>;

/** Payload of `headless.ended`: the process exited, timed out or was killed. */
export const HeadlessEndedSchema = z.strictObject({
  action_id: SlugSchema,
  outcome: z.enum(["done", "limit", "auth", "error"]),
  cause: HostErrorCauseSchema.optional(),
  exit_code: z.int().nullable(),
  duration_ms: z.int().nonnegative(),
});
export type HeadlessEnded = z.infer<typeof HeadlessEndedSchema>;

/** One engine-launched run in flight, for `StatusResult.headless_runs` and Flow Studio. */
export const HeadlessRunSummarySchema = z.strictObject({
  action_id: SlugSchema,
  role: RoleIdSchema,
  host: HostIdSchema,
  task: TaskIdSchema.optional(),
  pid: z.int().positive().nullable(),
  started_at: IsoDateTimeSchema,
});
export type HeadlessRunSummary = z.infer<typeof HeadlessRunSummarySchema>;
