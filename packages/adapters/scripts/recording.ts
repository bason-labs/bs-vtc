/**
 * Turning a live-check run into a fixture candidate (`live:check … --record <file>`, spine §7
 * rows on HostOutcome signals and on Codex limit and auth text). Pure. The stream is redacted the
 * way `docs/research/spike-fixtures/` is: session, thread and event ids become placeholders, the
 * temp repo, the home directory and the user name become `<cwd>`, `<home>` and `<user>`, e-mail
 * addresses become `<email>`, and every known token format goes through `redactSecrets`. What
 * names the owner's own setup is replaced with `<redacted>`: the Claude `init` event's `plugins`,
 * `skills`, `slash_commands`, `terminal_slash_commands`, `memory_paths` and
 * `messaging_socket_path`, every `agents` entry that is neither built in nor `vtc:`, an
 * `output_style` that is not built in, and a hook event's
 * `output`, `stdout` and `stderr` text (under `--setting-sources user` the user's own plugins and
 * hooks load into a role run, spine §5 reading 170). Opaque thinking signatures become
 * `<signature>`. The owner still reads a recording before it replaces a `*.synthetic.*` fixture.
 */
import { redactSecrets } from "@vtc/shared";

export interface RecordingContext {
  /** The home directory of the user who ran the check. */
  readonly home: string;
  /** The run's temp repo, under every spelling it may appear in (e.g. `/var/…` and `/private/var/…`). */
  readonly cwd: readonly string[];
  /** The login name, replaced where it stands as a word. */
  readonly user?: string;
}

/** JSON keys whose string value is an id, and the placeholder the recorded fixtures use for it. */
const ID_PLACEHOLDERS: Readonly<Record<string, string>> = {
  session_id: "<session-id>",
  thread_id: "<thread-id>",
  uuid: "<uuid>",
};

const REDACTED = "<redacted>";

/** The Claude `init` fields that name the owner's own plugins, skills, commands and paths. */
const INIT_PRIVATE_KEYS = [
  "plugins",
  "skills",
  "slash_commands",
  "terminal_slash_commands",
  "memory_paths",
  "messaging_socket_path",
] as const;

/** Claude Code's own subagents; any other `agents` entry but a `vtc:` one is the user's. */
const BUILT_IN_AGENTS: ReadonlySet<string> = new Set([
  "claude",
  "Explore",
  "general-purpose",
  "Plan",
  "statusline-setup",
]);

/** Claude Code's own output styles; any other name is a style the user wrote. */
const BUILT_IN_OUTPUT_STYLES: ReadonlySet<string> = new Set(["default", "Explanatory", "Learning"]);

const isSharedAgent = (name: unknown): boolean =>
  typeof name === "string" && (BUILT_IN_AGENTS.has(name) || name.startsWith("vtc:"));

/** A hook event's captured output, which can carry anything the user's hook prints. */
const HOOK_OUTPUT_KEYS = ["output", "stdout", "stderr"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The event with the owner-specific fields of its type replaced (top level only). */
const withoutOwnerSetup = (event: unknown): unknown => {
  if (!isObject(event) || event.type !== "system") return event;
  const keys =
    event.subtype === "init"
      ? INIT_PRIVATE_KEYS
      : typeof event.subtype === "string" && event.subtype.startsWith("hook_")
        ? HOOK_OUTPUT_KEYS
        : [];
  const out: Record<string, unknown> = { ...event };
  for (const key of keys) {
    const value = out[key];
    if (value !== undefined && value !== null && value !== "") out[key] = REDACTED;
  }
  if (event.subtype === "init") {
    const agents = out.agents;
    if (Array.isArray(agents)) {
      out.agents = (agents as readonly unknown[]).map((name): unknown =>
        isSharedAgent(name) ? name : REDACTED,
      );
    }
    const style = out.output_style;
    const builtIn = typeof style === "string" && BUILT_IN_OUTPUT_STYLES.has(style);
    if (style !== undefined && style !== null && !builtIn) {
      out.output_style = REDACTED;
    }
  }
  return out;
};

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redactText = (text: string, context: RecordingContext): string => {
  let out = redactSecrets(text).replace(EMAIL, "<email>");
  // the longest path first, so a cwd under the home directory is not left half replaced
  const paths: [string, string][] = [
    ...context.cwd.map((path): [string, string] => [path, "<cwd>"]),
    [context.home, "<home>"],
  ];
  paths.sort((a, b) => b[0].length - a[0].length);
  for (const [path, placeholder] of paths) {
    if (path !== "") out = out.split(path).join(placeholder);
  }
  if (context.user !== undefined && context.user !== "") {
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(context.user)}(?![A-Za-z0-9_-])`, "g"),
      "<user>",
    );
  }
  return out;
};

const redactValue = (value: unknown, context: RecordingContext, key?: string): unknown => {
  if (typeof value === "string") {
    if (key === "signature") return "<signature>";
    if (value === REDACTED) return value;
    const placeholder =
      key === undefined || !Object.hasOwn(ID_PLACEHOLDERS, key) ? undefined : ID_PLACEHOLDERS[key];
    return placeholder ?? redactText(value, context);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, context));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactValue(v, context, k)]),
    );
  }
  return value;
};

const parsed = (line: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch {
    return { ok: false };
  }
};

/** The redacted lines of a recorded stream; blank lines are dropped. */
export const redactRecording = (lines: readonly string[], context: RecordingContext): string[] =>
  lines
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const json = parsed(line);
      return json.ok
        ? JSON.stringify(redactValue(withoutOwnerSetup(json.value), context))
        : redactText(line, context);
    });

/** Where a run's recording goes: the given file, or for the resumed run `<name>.resume<ext>`. */
export const recordPath = (file: string, resumed: boolean): string => {
  if (!resumed) return file;
  const match = /^(.*[^/])(\.[^./]+)$/.exec(file);
  return match === null ? `${file}.resume` : `${match[1] ?? ""}.resume${match[2] ?? ""}`;
};
