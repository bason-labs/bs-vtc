/**
 * Dispatch policy (§4.2 step 2, §6.9, §12.4, §12.5; spine AD-4 rule 4, AD-17 and AD-25). Pure:
 * decides how a role run happens from the project's dispatch mode, the host of the run's Lead
 * session and what the role's host can do. The engine never starts a headless run unless this
 * returns `headless`.
 */
import type { SessionSandboxState } from "../engine-instance.js";
import { ROLE_DISPATCH_BY_LEAD_HOST } from "../headless.js";
import type { HostCapabilities } from "../interfaces/host-adapter.js";
import type { HostId } from "../primitives.js";
import type { DispatchMode } from "../project-config.js";
import type { ToolProfile } from "../role-contract.js";

/**
 * Why the engine wants a role run:
 * - `role`: a pipeline step (including the re-dispatch after a usage reset while the run's Lead
 *   session is connected);
 * - `auto_resume`: the timer woke the daemon and no Lead session is connected (§6.9 step 6);
 * - `cross_family_review`: the opt-in reviewer on the other host family (D10, §12.4);
 * - `lookback_replay`: a Lookback replay trial (§13, AD-21). New in 4.5.0; always headless since
 *   5.0.0 (D-cg).
 */
export type DispatchPurpose = "role" | "auto_resume" | "cross_family_review" | "lookback_replay";

/**
 * - `subagent`: a `spawn_role` action the Lead performs;
 * - `headless`: the engine launches it through `HostAdapter.spawnRole` (headless dispatch);
 * - `lead_redispatch`: plugin-only auto-resume. The step stays `interrupted`, `next` returns
 *   `wait` until the reset, then a `spawn_role` that resumes the same session;
 * - `unavailable`: cannot run in this mode (cross-family review in plugin-only mode, or a host
 *   with neither subagents nor allowed headless runs). The engine skips or parks it.
 */
export type DispatchPlan = "subagent" | "headless" | "lead_redispatch" | "unavailable";

/**
 * The one dispatch decision (AD-17 rule 1, AD-25 rule 6).
 *
 * `leadHost` is the host of the run's Lead session (`EngineSocketHello.host` of the bridge the
 * engine holds as the run's Lead), and `capabilities` are those of the host the role runs on.
 * Roles run on the Lead's own host; {@link ROLE_DISPATCH_BY_LEAD_HOST} says how by default
 * (H-1, 2026-10-14):
 * - `role` with a Lead whose default is `headless` (Codex) → `headless` whenever the host can,
 *   whatever `mode` says; that host has no in-session roles (reading 82), so without headless
 *   support the step is `unavailable`;
 * - otherwise `role` → `subagent` when the host has subagents, else `headless` only with
 *   `headless_allowed`;
 * - `lookback_replay` → `headless` whenever the host can, else `unavailable`, whatever `mode`
 *   says (D-cg, spine §5 reading 201, contracts 5.0.0): a replay trial is an engine-launched
 *   headless run in a clean checkout outside the repo, bounded by the Lead host's weekly window,
 *   the Lookback budget and `LOOKBACK_LIMITS.maxTrialsPerRetro`, so it needs no
 *   `headless_allowed`; on a host whose runs load the compiled agent each arm runs its own plugin
 *   (`SpawnRoleRequest.pluginDir`);
 * - `auto_resume` (no live Lead) → `headless` only with `headless_allowed`, else
 *   `lead_redispatch`: `headless_allowed` still governs every engine-driven run without a Lead;
 * - `cross_family_review` → `headless` only with `headless_allowed`.
 * Without `leadHost` (callers before 4.5.0) the Lead is taken to dispatch subagents, so plugin-only
 * mode never yields `headless`.
 */
export const planDispatch = (
  purpose: DispatchPurpose,
  mode: DispatchMode,
  capabilities: Pick<HostCapabilities, "subagents" | "headless">,
  leadHost?: HostId,
): DispatchPlan => {
  const headless = mode === "headless_allowed" && capabilities.headless;
  const leadRunsHeadless =
    leadHost !== undefined && ROLE_DISPATCH_BY_LEAD_HOST[leadHost] === "headless";
  switch (purpose) {
    case "role":
      if (leadRunsHeadless) return capabilities.headless ? "headless" : "unavailable";
      if (capabilities.subagents) return "subagent";
      return headless ? "headless" : "unavailable";
    case "lookback_replay":
      return capabilities.headless ? "headless" : "unavailable";
    case "auto_resume":
      return headless ? "headless" : "lead_redispatch";
    case "cross_family_review":
      return headless ? "headless" : "unavailable";
  }
};

/**
 * The text a task parks with (reason `blocked`, an escalation the human answers to retry) when
 * the engine refuses an in-session dispatch because the Lead session's sandbox settings are not
 * on (D-an, spine §5 readings 71 and 81).
 */
export const SESSION_SANDBOX_OFF_REASON =
  "the Lead session's sandbox and file-tool deny rules are not on, so no role can run in it: run `vtc install --host claude-code` in this repo (it shows and writes the settings to .claude/settings.local.json), restart the Claude Code session, then answer this escalation to retry";

/**
 * Platforms where Codex's network-off sandbox (`read-only`, or `workspace-write` with
 * `network_access = false`) is shown to block a `connect()` to a Unix socket as well as TCP
 * (macOS seatbelt, codex-cli 0.162.1, checked 2026-10-14; see the adapters' Codex profile). Only
 * there can a headless Codex role, which can read the VTC install token (Codex sandboxes allow
 * reads everywhere), be kept from presenting it to the engine's socket as a cli hello (D-an).
 */
export const CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS: readonly string[] = ["darwin"];

/**
 * The text a task parks with (reason `blocked`) when the engine refuses an in-session Codex
 * dispatch (spine §5 reading 82). A Codex custom agent inherits the parent session's sandbox,
 * approvals and MCP servers ("a custom agent file can't override those settings",
 * developers.openai.com/codex/subagents), so the compiled agent cannot pin the network off, and
 * nothing VTC can read shows that the Lead's own Codex session has it off (`--sandbox`,
 * `--yolo` and `/permissions` change it at runtime). A Codex role can read the install token, so
 * with the network on it could reach the engine's socket as a cli (a human channel).
 *
 * Since contracts 4.5.0 (H-1, AD-25) a Codex-led run does not reach this refusal for a role
 * step: `planDispatch` sends its roles headless, launched by the engine. The refusal still answers
 * any in-session Codex dispatch, e.g. on a Codex host whose CLI lacks headless support.
 */
export const CODEX_IN_SESSION_REFUSED_REASON =
  "a Codex role runs with the Lead session's own Codex sandbox and network (a Codex agent file cannot narrow them), VTC cannot confirm that sandbox keeps the network off, and a Codex role can read the VTC install token, so Codex roles do not run in-session; a Codex Lead's roles run as headless Codex runs the engine launches, and this one could not be launched: run vtc doctor (it checks codex exec and codex login status), or run the Lead in Claude Code (vtc install --host claude-code in this repo, then open it in Claude Code with the vtc plugin and continue the run), then answer this escalation to retry";

/**
 * Pure (D-an, spine §5 readings 71, 79, 81 and 82): why a `subagent` dispatch may not go ahead,
 * or `null` when it may.
 * - Claude Code: every role needs the Lead session to report its settings `on`
 *   (`EngineSocketHello.session_sandbox`; absent = `unknown`). The sandbox confines a role's
 *   shell, and the same settings' `permissions.deny` rules are what keep a role's Read, Edit and
 *   Write tools off the install token, the credential stores and the hidden-test checkouts: a
 *   compiled agent can carry no path rule (a specifier in its `disallowedTools` removes the whole
 *   tool), so no profile is safe without them.
 * - Codex: always refused in-session ({@link CODEX_IN_SESSION_REFUSED_REASON}); `platform` and
 *   the session report do not change that until a spine §7 spike shows a way to confirm the
 *   Codex Lead session's sandbox.
 */
export const inSessionDispatchRefusal = (
  host: HostId,
  _profile: ToolProfile,
  sessionSandbox: SessionSandboxState | undefined,
  _platform: string | undefined,
): string | null => {
  if (host === "codex") return CODEX_IN_SESSION_REFUSED_REASON;
  return sessionSandbox === "on" ? null : SESSION_SANDBOX_OFF_REASON;
};

/** Pure: whether {@link inSessionDispatchRefusal} lets the dispatch go ahead. */
export const inSessionDispatchAllowed = (
  host: HostId,
  profile: ToolProfile,
  sessionSandbox: SessionSandboxState | undefined,
  platform: string | undefined,
): boolean => inSessionDispatchRefusal(host, profile, sessionSandbox, platform) === null;

/**
 * The only Codex `web_search` mode a `host_web` role gets (D-cf, spine §5 reading 200): `cached`
 * answers from an OpenAI-maintained index and opens no page the model chooses, so a crafted page
 * cannot receive what a Codex role (which reads everywhere, reading 82) carries out in a URL.
 * `live` is never emitted; any other role gets `disabled`. The adapter always sets it explicitly,
 * because a full-access sandbox defaults to `live`. New in 5.0.0.
 */
export const CODEX_HOST_WEB_SEARCH = "cached";

/** The visible run notice when a `host_web` role runs without host web search (D-cf). */
export const HOST_WEB_OFF_NOTICE =
  "the research role runs without its host's web search on this run: no available host could search without opening pages the model picks, so research uses the engine's own fetchers only (install Claude Code, or see vtc doctor for the Codex web search check)";

/** Where a `host_web` role runs, and whether it keeps host web search (D-cf). */
export type HostWebRoute =
  | { readonly host: HostId; readonly hostWeb: true }
  | { readonly host: HostId; readonly hostWeb: false; readonly notice: string };

/**
 * Pure (D-cf, spine §5 reading 200): the host a `host_web` role runs on. `hosts` says, for each
 * host the role could be dispatched to now (`planDispatch` gives a plan other than
 * `unavailable`), whether its host web is safe (`HostCapabilities.safeHostWeb`).
 * 1. Claude Code when it is dispatchable and safe: its role profiles deny the credential stores;
 * 2. else the Lead's host when it is safe (Codex with `cached` confirmed);
 * 3. else the Lead's host without host web, with {@link HOST_WEB_OFF_NOTICE}; the engine's `web`
 *    fetcher still serves the role's source requests.
 */
export const hostWebRoute = (
  leadHost: HostId,
  hosts: Readonly<
    Partial<Record<HostId, { readonly dispatchable: boolean; readonly safeHostWeb: boolean }>>
  >,
): HostWebRoute => {
  const claude = hosts["claude-code"];
  if (claude?.dispatchable === true && claude.safeHostWeb)
    return { host: "claude-code", hostWeb: true };
  const lead = hosts[leadHost];
  if (lead?.dispatchable === true && lead.safeHostWeb) return { host: leadHost, hostWeb: true };
  return { host: leadHost, hostWeb: false, notice: HOST_WEB_OFF_NOTICE };
};
