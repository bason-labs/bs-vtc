/**
 * What headless Claude role runs load from the user's own Claude settings (D-bp, spine §5
 * reading 170; AD-25 rule 1). Role runs pass `--setting-sources user`, so the user's hooks and
 * enabled plugins (with the plugins' skills and hooks) run in them; the 2026-10-14 live check saw
 * a plugin's `SessionStart` hook inject context into a role session. It is a §7 accepted residual,
 * bounded by the role's `--tools`, every deny rule and the engine's write-scope check, and
 * `vtc doctor` lists what will load. Only the user's `settings.json` is read, never the
 * credentials beside it (AD-9), and only hook commands and plugin names are shown, secrets
 * redacted: no other setting (`env`, `apiKeyHelper`, …) is echoed.
 */
import { redactSecrets } from "@vtc/shared";
import type { DoctorCheck } from "./doctor-checks.js";
import { printable as escapeControls } from "./human-gesture.js";
import type { LocalSettingsRead } from "./session-sandbox.js";

/** One hook in the user's settings: its event, its matcher, and what it runs. */
export interface UserHook {
  readonly event: string;
  readonly matcher: string | null;
  /** The command (redacted, one line, capped), or which kind of hook it is. */
  readonly what: string;
}

export interface ClaudeUserExtensions {
  /** `disableAllHooks: true`: no hook runs at all. */
  readonly hooksDisabled: boolean;
  readonly hooks: readonly UserHook[];
  /** `enabledPlugins` entries that are not switched off (`name@marketplace`). */
  readonly plugins: readonly string[];
}

const MAX_COMMAND = 120;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One line: whitespace runs become a space, other control characters `\uXXXX` escapes. */
const printable = (text: string): string => escapeControls(text.replace(/\s+/g, " "));

const describeHook = (hook: unknown): string => {
  if (!isRecord(hook)) return "a hook";
  if (hook.type === "command" && typeof hook.command === "string") {
    const line = printable(redactSecrets(hook.command)).trim();
    return line.length > MAX_COMMAND ? `${line.slice(0, MAX_COMMAND - 1)}…` : line;
  }
  return typeof hook.type === "string" && /^[a-z_]{1,32}$/i.test(hook.type)
    ? `a ${hook.type} hook`
    : "a hook";
};

/** The hooks and enabled plugins in a parsed user `settings.json`; malformed parts are skipped. */
export const claudeUserExtensionsOf = (settings: Record<string, unknown>): ClaudeUserExtensions => {
  const hooks: UserHook[] = [];
  if (isRecord(settings.hooks))
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
        const matcher =
          typeof group.matcher === "string" && group.matcher !== "" ? group.matcher : null;
        for (const hook of group.hooks)
          hooks.push({
            event: printable(event),
            matcher: matcher === null ? null : printable(matcher),
            what: describeHook(hook),
          });
      }
    }
  const plugins = isRecord(settings.enabledPlugins)
    ? Object.entries(settings.enabledPlugins)
        .filter(([, on]) => on !== false && on !== null && on !== undefined)
        .map(([name]) => printable(name))
    : [];
  return { hooksDisabled: settings.disableAllHooks === true, hooks, plugins };
};

const RESIDUAL =
  "An accepted residual (spine §7): role runs stay bounded by their tools, every deny rule and the engine's write-scope check; remove from that file what you do not want in role runs";

const ROLE_RUNS = "headless Claude role runs";

/**
 * Doctor's lines for the user's Claude settings: the hooks and the plugins that will run in
 * headless role runs, as `info` (they fail nothing), `ok` when there are none, and a warning
 * when the file cannot be read (then doctor cannot say).
 */
export const checkClaudeUserSettings = (read: LocalSettingsRead): DoctorCheck[] => {
  const { path } = read;
  if (read.kind === "absent")
    return [
      {
        name: "user hooks",
        status: "ok",
        detail: `no Claude user settings (${path}), so no user hooks or plugins load in ${ROLE_RUNS}`,
      },
    ];
  if (read.kind === "unreadable")
    return [
      {
        name: "user hooks",
        status: "warn",
        detail: `${path} cannot be read (${read.error}), so doctor cannot list the user hooks and plugins ${ROLE_RUNS} load`,
      },
    ];
  const found = claudeUserExtensionsOf(read.settings);
  const n = found.hooks.length;
  const hooks: DoctorCheck = found.hooksDisabled
    ? {
        name: "user hooks",
        status: "ok",
        detail: `disableAllHooks is on in ${path}, so no hook runs in ${ROLE_RUNS} (VTC's own plugin hooks included)`,
      }
    : n === 0
      ? {
          name: "user hooks",
          status: "ok",
          detail: `no user hooks in ${path}, so none run in ${ROLE_RUNS}`,
        }
      : {
          name: "user hooks",
          status: "info",
          detail: `${String(n)} user ${n === 1 ? "hook" : "hooks"} in ${path} ${n === 1 ? "runs" : "run"} in ${ROLE_RUNS} (--setting-sources user): ${found.hooks
            .map((h) => `${h.event}${h.matcher === null ? "" : `(${h.matcher})`}: ${h.what}`)
            .join("; ")}. ${RESIDUAL}`,
        };
  const p = found.plugins.length;
  const plugins: DoctorCheck =
    p === 0
      ? {
          name: "user plugins",
          status: "ok",
          detail: `no user plugins enabled in ${path}, so none load in ${ROLE_RUNS}`,
        }
      : {
          name: "user plugins",
          status: "info",
          detail: `${String(p)} enabled user ${p === 1 ? "plugin loads" : "plugins load"} in ${ROLE_RUNS}, with their skills and hooks: ${found.plugins.join(", ")}. ${RESIDUAL}`,
        };
  return [hooks, plugins];
};
