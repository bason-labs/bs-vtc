/**
 * The improvement signals of D-cd that had no source (D-cs; spine §5 reading 221). New in 5.4.0.
 *
 * - **tool**: the engine records a normalised command shape for each shell call of a role run
 *   ({@link CommandShape}: the program, its subcommand and a hash of its flag names; never an
 *   argument value or a path), on `role.submitted.command_shapes`, in the local run log only. A
 *   shape seen in {@link TOOL_SIGNAL_MIN_TASKS} or more distinct tasks raises a `tool` fact (spec
 *   §13 tool promotion). Headless runs: the adapter's `ParsedStream.commandShapes`. In-session
 *   subagents: `vtc hook pre-tool-use` appends one {@link CommandShapeSpoolRow} per shell call to
 *   the engine's private spool ({@link COMMAND_SHAPE_SPOOL_FILE}), which the engine drains into
 *   the dispatch's `role.submitted`.
 * - **capability**: an escalation may carry a structured {@link MissingCapability} (a short slug
 *   and a reason), filled by the role (`Question.missing_capability`) or by the Lead
 *   (`EscalationAnswer.missing_capability`). A slug that recurs {@link CAPABILITY_SIGNAL_MIN} or
 *   more times raises a `capability` fact.
 * - **routing**: Lookback's routing scorecards (D-cn, `RoutingScorecard`) raise `config` facts named
 *   by `routingConfigSubject`.
 */
import { z } from "zod";
import { sha256Hex } from "./helpers/fingerprint.js";
import { IsoDateTimeSchema, SlugSchema } from "./primitives.js";

/** Distinct tasks a command shape needs before it raises a `tool` fact (§13 tool promotion). */
export const TOOL_SIGNAL_MIN_TASKS = 3;

/** Escalations a missing-capability slug needs before it raises a `capability` fact. */
export const CAPABILITY_SIGNAL_MIN = 2;

/** `program` when the program is named by a path (`./x.sh`, `/usr/bin/x`). */
export const COMMAND_SHAPE_PATH = "<path>";
/** `program` when it is an expansion or not a plain word (`$X`, `` `x` ``, `"a b"`). */
export const COMMAND_SHAPE_OTHER = "<other>";

/**
 * One shell call's shape: what was run, never with what. `flags` is the first 12 hex of the SHA-256
 * of the sorted, de-duplicated flag names (`--x=1` counts as `--x`), one per line; no flag: the
 * hash of the empty string.
 */
export const CommandShapeSchema = z.strictObject({
  program: z.string().regex(/^(<path>|<other>|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/),
  subcommand: z
    .string()
    .regex(/^[a-z][a-z0-9:_-]{0,39}$/)
    .optional(),
  flags: z.string().regex(/^[a-f0-9]{12}$/),
});
export type CommandShape = z.infer<typeof CommandShapeSchema>;

/** A shape with how often one role run used it (`role.submitted.command_shapes`). */
export const CommandShapeCountSchema = CommandShapeSchema.extend({
  count: z.int().positive().max(100_000),
});
export type CommandShapeCount = z.infer<typeof CommandShapeCountSchema>;

/** Most shapes one `role.submitted` carries (the most used first). */
export const MAX_COMMAND_SHAPES_PER_RUN = 100;
/** Most shapes {@link commandShapes} returns for one command line. */
export const MAX_SHAPES_PER_COMMAND = 20;

/** Pure: one key per shape, for counting across runs (`git status 1a2b3c4d5e6f`). */
export const commandShapeKey = (shape: CommandShape): string =>
  `${shape.program} ${shape.subcommand ?? "-"} ${shape.flags}`;

/**
 * The programs whose next word is a subcommand (`git status`, `pnpm install`, `docker build`), not
 * an argument (spine §5 reading 228, amending 221(1)). After any other program the next word is an
 * argument (a file, a host, a database, a make target such as `make deploy-acme`, or a value such
 * as `echo hunter2`), so no subcommand is recorded. A package manager's next word may still be a
 * script of the project (`pnpm acme-migrate`): that stays in the project's own run log, and the
 * key a `tool` fact sends upstream keeps the subcommand only for engine core's stricter list
 * (`toolShapeUpstreamKey`). New in 5.5.0.
 */
export const COMMAND_SHAPE_SUBCOMMAND_PROGRAMS: readonly string[] = [
  "apt",
  "apt-get",
  "aws",
  "az",
  "brew",
  "bun",
  "cargo",
  "claude",
  "codex",
  "conda",
  "deno",
  "docker",
  "dotnet",
  "gcloud",
  "gh",
  "git",
  "go",
  "helm",
  "kubectl",
  "npm",
  "pip",
  "pip3",
  "pnpm",
  "podman",
  "poetry",
  "rustup",
  "systemctl",
  "terraform",
  "turbo",
  "uv",
  "vtc",
  "yarn",
];
const SUBCOMMAND_PROGRAMS: ReadonlySet<string> = new Set(COMMAND_SHAPE_SUBCOMMAND_PROGRAMS);

const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n", "(", ")"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PLAIN_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SUBCOMMAND = /^[a-z][a-z0-9:_-]{0,39}$/;

/**
 * A here-document whose operator (`<<WORD`, `<<-WORD`) a shell lexer read: its body comes on the
 * lines after the operator's line. New in 5.6.0.
 */
export interface Heredoc {
  readonly delimiter: string;
  /** `<<-`: leading tabs of the body's lines, the delimiter line's included, are stripped. */
  readonly strip: boolean;
}

/**
 * Pure: the index after the bodies of `pending` here-documents, read in order from `from` (the
 * start of the line after their operators' line): each runs to the line that equals its delimiter
 * (tab-stripped for `<<-`), or to the end of the input when none does. The one copy of the rule
 * `commandShapes` and the adapters' shell-wrapper reader both skip bodies by. New in 5.6.0.
 */
export const skipHeredocBodies = (
  line: string,
  from: number,
  pending: readonly Heredoc[],
): number => {
  let at = from;
  for (const doc of pending) {
    while (at < line.length) {
      const end = line.indexOf("\n", at);
      const text = line.slice(at, end < 0 ? line.length : end).replace(/\r$/, "");
      at = end < 0 ? line.length : end + 1;
      if ((doc.strip ? text.replace(/^\t+/, "") : text) === doc.delimiter) break;
    }
  }
  return at;
};

/**
 * Pure: the here-document operator at `at` (`<<`, the caller has ruled out the here-string `<<<`):
 * its delimiter word with quotes and backslashes removed, and the index after it; `null` when no
 * word follows. New in 5.6.0.
 */
export const heredocAt = (
  line: string,
  at: number,
): { readonly doc: Heredoc; readonly next: number } | null => {
  let j = at + 2;
  const strip = line[j] === "-";
  if (strip) j += 1;
  while (line[j] === " " || line[j] === "\t") j += 1;
  let delimiter = "";
  while (j < line.length) {
    const d = line[j] ?? "";
    if (d === "\\" && j + 1 < line.length) {
      delimiter += line[j + 1] ?? "";
      j += 2;
    } else if (d === "'" || d === '"') {
      const end = line.indexOf(d, j + 1);
      const stop = end < 0 ? line.length : end;
      delimiter += line.slice(j + 1, stop);
      j = stop + 1;
    } else if (" \t\r\n;&|()<>".includes(d)) break;
    else {
      delimiter += d;
      j += 1;
    }
  }
  return delimiter === "" ? null : { doc: { delimiter, strip }, next: j };
};

/**
 * Splits a shell line into words and separators; quotes group, backslashes escape. A here-document
 * (`<<WORD`, `<<-WORD`, the word quoted or not) is a redirection whose body, the lines after its
 * line up to the delimiter, is data: it yields no word, so no body line is read as a command
 * (5.6.0). Lenient.
 */
const lex = (
  line: string,
): { readonly text: string; readonly quoted: boolean; readonly sep: boolean }[] => {
  const out: { text: string; quoted: boolean; sep: boolean }[] = [];
  let word = "";
  let quoted = false;
  let inWord = false;
  let pending: Heredoc[] = [];
  const flush = (): void => {
    if (inWord) out.push({ text: word, quoted, sep: false });
    word = "";
    quoted = false;
    inWord = false;
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] ?? "";
    const two = line.slice(i, i + 2);
    if (c === "\\" && i + 1 < line.length) {
      word += line[i + 1] ?? "";
      inWord = true;
      i += 1;
    } else if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1);
      const stop = end < 0 ? line.length : end;
      word += line.slice(i + 1, stop);
      quoted = true;
      inWord = true;
      i = stop;
    } else if (line.startsWith("<<<", i)) {
      word += "<<<";
      inWord = true;
      i += 2;
    } else if (two === "<<") {
      flush();
      const heredoc = heredocAt(line, i);
      if (heredoc === null) i += 1;
      else {
        pending.push(heredoc.doc);
        i = heredoc.next - 1;
      }
    } else if (two === "&&" || two === "||") {
      flush();
      out.push({ text: two, quoted: false, sep: true });
      i += 1;
    } else if (SEPARATORS.has(c)) {
      flush();
      out.push({ text: c, quoted: false, sep: true });
      if (c === "\n" && pending.length > 0) {
        i = skipHeredocBodies(line, i + 1, pending) - 1;
        pending = [];
      }
    } else if (c === " " || c === "\t" || c === "\r") {
      flush();
    } else {
      word += c;
      inWord = true;
    }
  }
  flush();
  return out;
};

/**
 * A flag word's name with no value byte (5.6.0): a long flag keeps its name (`--token=x` is
 * `--token`); a single-dash word keeps its first letter, since `-pVALUE` cannot be told from
 * combined short flags (`-la` is `-l`, `-uroot` is `-u`); a numeric flag is `-#` (`head -20`).
 */
const flagName = (text: string): string => {
  if (text.startsWith("--")) return text.split("=")[0] ?? text;
  const first = text[1] ?? "";
  return /^[0-9]$/.test(first) ? "-#" : `-${first}`;
};

const shapeOf = (
  words: readonly { readonly text: string; readonly quoted: boolean }[],
): CommandShape | null => {
  let at = 0;
  // leading `VAR=value` assignments, and `env`'s own, name no program
  while (
    at < words.length &&
    !(words[at]?.quoted ?? true) &&
    ASSIGNMENT.test(words[at]?.text ?? "")
  )
    at += 1;
  if (words[at]?.text === "env") {
    at += 1;
    while (at < words.length && ASSIGNMENT.test(words[at]?.text ?? "")) at += 1;
  }
  const head = words[at];
  if (head === undefined) return null;
  const program = head.text.includes("/")
    ? COMMAND_SHAPE_PATH
    : !head.quoted && PLAIN_PROGRAM.test(head.text)
      ? head.text
      : COMMAND_SHAPE_OTHER;
  const next = words[at + 1];
  const subcommand =
    SUBCOMMAND_PROGRAMS.has(program) &&
    next !== undefined &&
    !next.quoted &&
    SUBCOMMAND.test(next.text)
      ? next.text
      : undefined;
  const flags = [
    ...new Set(
      words
        .slice(at + 1)
        .filter((w) => !w.quoted && w.text.startsWith("-") && w.text !== "-" && w.text !== "--")
        .map((w) => flagName(w.text)),
    ),
  ].sort();
  return {
    program,
    ...(subcommand === undefined ? {} : { subcommand }),
    flags: sha256Hex(flags.join("\n")).slice(0, 12),
  };
};

/**
 * Pure (D-cs): the shapes of one shell command line, one per simple command (split at `&&`, `||`,
 * `;`, `|`, `&`, newlines and parentheses), at most {@link MAX_SHAPES_PER_COMMAND}. Leading
 * `VAR=value` assignments and an `env` prefix are skipped; a program named by a path is
 * {@link COMMAND_SHAPE_PATH}; the subcommand is the word right after the program when the program
 * is one of {@link COMMAND_SHAPE_SUBCOMMAND_PROGRAMS} and the word is a plain lower-case word. No
 * argument value or path survives: only flag names, hashed, and no value byte reaches the hash (a
 * single-dash word keeps its first letter, a long flag its name, a numeric flag is `-#`; 5.6.0). A
 * here-document's body is skipped, never shaped (5.6.0).
 */
export const commandShapes = (command: string): CommandShape[] => {
  const shapes: CommandShape[] = [];
  let words: { text: string; quoted: boolean }[] = [];
  const end = (): void => {
    const shape = shapeOf(words);
    if (shape !== null && shapes.length < MAX_SHAPES_PER_COMMAND) shapes.push(shape);
    words = [];
  };
  for (const token of lex(command.slice(0, 100_000))) {
    if (token.sep) end();
    else words.push({ text: token.text, quoted: token.quoted });
  }
  end();
  return shapes;
};

/** Pure: shapes counted per key, most used first, at most {@link MAX_COMMAND_SHAPES_PER_RUN}. */
export const countCommandShapes = (shapes: readonly CommandShape[]): CommandShapeCount[] => {
  const counts = new Map<string, CommandShapeCount>();
  for (const shape of shapes) {
    const key = commandShapeKey(shape);
    const seen = counts.get(key);
    counts.set(key, { ...shape, count: (seen?.count ?? 0) + 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || commandShapeKey(a).localeCompare(commandShapeKey(b)))
    .slice(0, MAX_COMMAND_SHAPES_PER_RUN);
};

/**
 * The spool `vtc hook pre-tool-use` appends one row to per shell call of a VTC role agent in a Lead
 * session, inside the engine's private directory (`<vtcHome>/guard/<repo-key>/`, which no role
 * may write). Only the hook appends (`O_APPEND`, created `0600`, a symlink refused); only the
 * engine reads and truncates it. A row that does not parse is skipped.
 */
export const COMMAND_SHAPE_SPOOL_FILE = "command-shapes.jsonl";

export const CommandShapeSpoolRowSchema = z.strictObject({
  v: z.literal(1),
  at: IsoDateTimeSchema,
  /** The host's `agent_type` (e.g. `vtc:vtc-engineer-backend`). */
  agent: z.string().min(1).max(256),
  /** The host session id, when the host reports one. */
  session: z.string().min(1).max(256).optional(),
  /** The hook's absolute `cwd` (the role's worktree), which maps the call to its dispatch. */
  cwd: z.string().min(1).max(4096),
  shape: CommandShapeSchema,
  /**
   * The dispatch the call belongs to (its `action_id`), when the hook can name exactly one: the
   * daemon's in-flight dispatches for this agent and `cwd` (which hook rule 4 already reads for the
   * write scope) number one. Absent (no daemon answer, or parallel runs of one agent in one
   * worktree such as the per-AC Spec Verifier calls): the engine matches the row by `agent` and
   * `cwd` as before. The engine still checks that a named action is in flight for that agent and
   * `cwd` before it counts the row (spine §5 reading 247(9)). New in 5.7.0.
   */
  action: SlugSchema.optional(),
});
export type CommandShapeSpoolRow = z.infer<typeof CommandShapeSpoolRowSchema>;

/**
 * A capability a role or the Lead says was missing (D-cs): a short slug (`browser_automation`,
 * `db_migration_runner`) and why. On `Question`, `Escalation` and `EscalationAnswer`.
 */
export const MissingCapabilitySchema = z.strictObject({
  slug: SlugSchema,
  reason: z.string().min(1).max(300),
});
export type MissingCapability = z.infer<typeof MissingCapabilitySchema>;
