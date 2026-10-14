/**
 * Owner: cli+binary team. `vtc merge-level restore [--level 1|2|3] [--reason <text>]` (spine AD-23
 * rule 5, §5 reading 104). The engine lowers the merge level after a revert or a red required
 * base run by appending a `downgrade` to the git-tracked ledger `.vtc/merge-level.jsonl`
 * (`MERGE_LEVEL_LEDGER`); it never edits `project.yaml`, and only a human raises the cap again.
 * This command shows the ledger's cap and, after a yes at an interactive terminal, appends a
 * `restore` entry (`reason: human`). `--level` is the new cap (default 3: the level in
 * `project.yaml` applies again). Commit the ledger so teammates share it (D8).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { core, git } from "@vtc/engine";
import {
  effectiveMergeLevel,
  MERGE_LEVEL_LEDGER,
  MergeLevelLedgerEntrySchema,
  MergeLevelSchema,
  parsePersisted,
  redactSecrets,
  type MergeLevel,
  type MergeLevelLedgerEntry,
} from "@vtc/shared";
import {
  defaultGestureDeps,
  EXIT_NOT_CONFIRMED,
  needsTerminal,
  printable,
  type GestureDeps,
} from "../human-gesture.js";
import { requireRepoRoot, requireVtcProject, UsageError } from "../repo.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const USAGE = "usage: vtc merge-level restore [--level 1|2|3] [--reason <text>]";

export interface LedgerRead {
  /** The file's text as read ("" when it is missing). */
  readonly text: string;
  readonly entries: readonly MergeLevelLedgerEntry[];
  /** 1-based line numbers that did not parse (skipped). */
  readonly skipped: readonly number[];
}

/**
 * The ledger's entries in order; a missing file is empty. Lines that do not parse are skipped.
 * The ledger is git-tracked, so a cloned repo controls it: it is never read through a symlink.
 */
export const readMergeLevelLedger = (repoRoot: string): LedgerRead => {
  let text = "";
  git.assertNoSymlinks(repoRoot, MERGE_LEVEL_LEDGER);
  try {
    text = readFileSync(join(repoRoot, MERGE_LEVEL_LEDGER), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  const entries: MergeLevelLedgerEntry[] = [];
  const skipped: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      skipped.push(i + 1);
      return;
    }
    const parsed = parsePersisted(MergeLevelLedgerEntrySchema, raw);
    if (parsed.success) entries.push(parsed.data);
    else skipped.push(i + 1);
  });
  return { text, entries, skipped };
};

const capOf = (entries: readonly MergeLevelLedgerEntry[]): MergeLevel =>
  effectiveMergeLevel(3, entries);

export const createMergeLevelCommand = (
  deps: () => GestureDeps = defaultGestureDeps,
): CommandSpec => ({
  name: "merge-level",
  summary:
    "Restore the merge level after an automatic downgrade (vtc merge-level restore; you confirm at the terminal)",
  run: (args, ctx) =>
    guarded("merge-level", ctx, async () => {
      const { values, positionals } = parseFlags(
        args,
        { level: { type: "string" }, reason: { type: "string" } },
        true,
      );
      if (positionals.length !== 1 || positionals[0] !== "restore") throw new UsageError(USAGE);
      const level = MergeLevelSchema.safeParse(Number(values.level ?? "3"));
      if (!level.success) throw new UsageError(`--level must be 1, 2 or 3; ${USAGE}`);
      const d = deps();
      const repoRoot = await requireRepoRoot(ctx.cwd);
      requireVtcProject(repoRoot);
      const configured = core.loadProjectConfig(repoRoot).merge_level;
      const ledger = readMergeLevelLedger(repoRoot);
      for (const line of ledger.skipped)
        ctx.io.err(
          `vtc merge-level: ${MERGE_LEVEL_LEDGER} line ${String(line)} does not parse; skipped`,
        );
      const cap = capOf(ledger.entries);
      const effective = effectiveMergeLevel(configured, ledger.entries);
      if (level.data <= cap) {
        ctx.io.out(
          `Nothing to restore: the ledger caps the merge level at ${String(cap)} (project.yaml says ${String(configured)}, so it is ${String(effective)}).`,
        );
        return EXIT.ok;
      }
      const last = [...ledger.entries].reverse().find((e) => e.kind === "downgrade");
      ctx.io.out(
        `The merge level is ${String(effective)}: project.yaml says ${String(configured)}, and ${MERGE_LEVEL_LEDGER} caps it at ${String(cap)}.`,
      );
      if (last !== undefined)
        ctx.io.out(
          `  last downgrade ${last.at}: ${last.reason}${last.feature === undefined ? "" : ` (${printable(last.feature)})`}: ${printable(last.detail)}`,
        );
      const after = Math.min(configured, level.data);
      ctx.io.out(
        `Restoring raises the cap to ${String(level.data)}, so the merge level becomes ${String(after)}.`,
      );
      if (!d.interactive()) {
        ctx.io.err(`vtc merge-level: ${needsTerminal("restoring the merge level")}`);
        return EXIT_NOT_CONFIRMED;
      }
      if (!(await d.confirm(`Restore the merge level to ${String(after)}?`))) {
        ctx.io.out("Not confirmed: the ledger is unchanged.");
        return EXIT_NOT_CONFIRMED;
      }
      // a restore overrides every earlier downgrade, so it must not clear one the human never saw:
      // the engine may have appended a downgrade (a revert, a red base run) while they decided
      if (readMergeLevelLedger(repoRoot).text !== ledger.text) {
        ctx.io.err(
          `vtc merge-level: ${MERGE_LEVEL_LEDGER} changed while you decided; run it again to see the new entries`,
        );
        return EXIT.failed;
      }
      const reason = (values.reason ?? "").trim();
      const entry = MergeLevelLedgerEntrySchema.parse({
        v: 1,
        at: d.now().toISOString(),
        kind: "restore",
        cap: level.data,
        reason: "human",
        detail: redactSecrets(
          reason === "" ? "restored by a human with vtc merge-level restore" : reason,
        ).slice(0, 500),
      } satisfies MergeLevelLedgerEntry);
      git.appendRepoFile(repoRoot, MERGE_LEVEL_LEDGER, `${JSON.stringify(entry)}\n`);
      ctx.io.out(
        `Appended a restore to ${MERGE_LEVEL_LEDGER}; the merge level is ${String(effectiveMergeLevel(configured, [...ledger.entries, entry]))}. Commit the file so teammates share it.`,
      );
      return EXIT.ok;
    }),
});

export const command = createMergeLevelCommand();
