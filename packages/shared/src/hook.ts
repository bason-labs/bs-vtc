/**
 * The `vtc hook` command contract (AD-8 rule 3, AD-16; spine §5 reading 31). Host plugins wire
 * their hooks to `vtc hook <event> --host <host>`: the compiler emits that wiring with
 * {@link vtcHookCommand}, the cli+binary team implements the command. Hooks are an extra layer of
 * defence only, never the enforcement point: the engine still checks every write and every
 * submit, so the command fails open.
 *
 * Contract:
 * 1. Input: the host's hook JSON on stdin, at most `VTC_HOOK.maxStdinBytes`, parsed with
 *    {@link VtcHookInputSchema} (the host's own format, read tolerantly: unknown keys are kept and
 *    ignored).
 * 2. Exit `VTC_HOOK.exit.allow` (0) with no output when no VTC run is active for the repo, on
 *    unparseable or oversized input, and on any internal error (fail open). `pre-tool-use` and
 *    `subagent-stop` also allow silently when no daemon answers; `session-start` does not need
 *    one (rule 3).
 * 3. `session-start`: when a run is unfinished, print a one-paragraph resume hint ("Resume run?",
 *    `next` / `status`) on stdout, which the host adds to the Lead's context. Never blocks. The
 *    hint does not wait for the daemon (D-af, spine §5 reading 52): after a reboot the bridge
 *    starts the daemon at the same moment the Lead session starts, so the hook also prints it when
 *    the committed event log (`.vtc/runs/<run>/events.jsonl`, read only, never written) shows a
 *    run with no `run.finished`. Reading the log fails open like everything else, within
 *    `VTC_HOOK.timeoutMs`.
 * 4. `pre-tool-use`: blocks (exit `VTC_HOOK.exit.block` (2), the reason on stderr, at most
 *    `VTC_HOOK.maxReasonChars`) only when the caller is a VTC role agent (`agent_type` starting
 *    with `AGENT_NAME_PREFIX`, after the host's namespace) and the call is either
 *    - a git command that commits, pushes, merges, rebases, resets or changes config. The engine
 *      owns every commit and ref of a run, so this reads as also covering ref writes (creating,
 *      moving or deleting branches, tags, stash entries, symbolic refs, worktrees, notes and
 *      replacements; `filter-branch`) and per-call config overrides (`git -c`, `--config-env`),
 *      because an override such as an `alias.*` or `core.fsmonitor` value can hide a write. An
 *      override of an output-only key is allowed: `color.*`, `column.*`, `advice.*`, `log.*`,
 *      `grep.*`, `status.*`, `i18n.*`, `core.quotepath`, `core.abbrev`, diff display keys, and
 *      pager keys whose value is a plain pager such as `cat` or `less` (spine §5 reading 64); or
 *    - a write outside the agent's effective write scope (D-ag, spine §5 reading 53), which is:
 *      its own worktree, within its in-flight dispatch's write scope; its main-checkout staging
 *      entries (`HIDDEN_TESTS.stagingDir/<task>/`, relative to the main checkout, spine §5
 *      reading 65); and the OS temp directory (`$TMPDIR`, `/tmp`, `/private/tmp`, and
 *      `/var/folders` on macOS). A write anywhere else stays blocked.
 *    Everything else is allowed.
 * 5. `subagent-stop`: for a VTC role agent, print a reminder on stdout that the Lead must
 *    `submit` its result (or failure). Never blocks.
 * 6. The command finishes within `VTC_HOOK.timeoutMs`; the plugin's hook timeout is set to it.
 * The host-side event names and input fields are provisional until the spike (§7).
 */
import { z } from "zod";
import { HostIdSchema, type HostId } from "./primitives.js";

export const VtcHookEventSchema = z.enum(["session-start", "pre-tool-use", "subagent-stop"]);
export type VtcHookEvent = z.infer<typeof VtcHookEventSchema>;

export const VTC_HOOK = {
  maxStdinBytes: 1024 * 1024,
  timeoutMs: 10_000,
  maxReasonChars: 500,
  exit: { allow: 0, block: 2 },
} as const;

/** The command a host plugin runs for `event`: `vtc hook <event> --host <host>`. */
export const vtcHookCommand = (
  event: VtcHookEvent,
  host: HostId,
): { readonly command: "vtc"; readonly args: readonly string[] } => ({
  command: "vtc",
  args: ["hook", VtcHookEventSchema.parse(event), "--host", HostIdSchema.parse(host)],
});

/**
 * The fields `vtc hook` reads from the host's hook JSON. The host owns this format, so it is a
 * loose object: unknown keys pass through and every field is optional (a missing field means
 * "not a VTC role agent", which allows the call).
 */
export const VtcHookInputSchema = z.looseObject({
  session_id: z.string().max(256).optional(),
  cwd: z.string().max(4096).optional(),
  hook_event_name: z.string().max(100).optional(),
  /** The subagent's name where the host reports it (e.g. `vtc:vtc-engineer-backend`). */
  agent_type: z.string().max(256).optional(),
  tool_name: z.string().max(200).optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
});
export type VtcHookInput = z.infer<typeof VtcHookInputSchema>;
