/**
 * The control commands `vtc status`, `vtc pause`, `vtc resume` and `vtc cancel` (AD-19 rule 4): MCP clients of
 * the repo's daemon socket through `ctx.engine()`, never HTTP. `--run <id>` names a run; the
 * engine acts on the active one otherwise. `--json` prints the tool's output as is. `pause` and
 * `resume` with no run to act on still set or clear the automation kill switch and exit 0.
 */
import type { CancelResult, ControlResult, StatusResult, UsageReport } from "@vtc/shared";
import type { CommandContext, CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const usageLines = (usage: UsageReport): string[] => {
  const hosts = usage.hosts.map((h) => {
    const windows = h.windows.map(
      (w) =>
        `${w.label} ${w.used_pct === null ? "unknown" : `${String(Math.round(w.used_pct))}% used`}${w.resets_at === null ? "" : ` (resets ${w.resets_at})`}`,
    );
    const limits = h.model_limits.map(
      (m) => `${m.model} limit reached${m.resets_at === null ? "" : `, resets ${m.resets_at}`}`,
    );
    const all = [...windows, ...limits];
    return `  ${h.host}: ${all.length === 0 ? "unknown" : all.join("; ")}`;
  });
  return [
    "Usage:",
    ...(hosts.length === 0 ? ["  unknown"] : hosts),
    ...(usage.interrupted_tasks.length === 0
      ? []
      : [`  interrupted by a limit: ${usage.interrupted_tasks.join(", ")}`]),
    ...(usage.auto_resume_at === null ? [] : [`  auto-resume at ${usage.auto_resume_at}`]),
  ];
};

/**
 * The run's spend against its cap. A run has a cap only once it has features (the sum of their
 * budgets) or a run-scope `budget.updated`; before that (a quick fix's BA step, the owner's first
 * run) the engine reports `budget_usd` 0, which is no cap, not a cap of $0.
 */
export const budgetLine = (budget: StatusResult["budget"]): string =>
  budget.budget_usd > 0
    ? `Budget: $${budget.spent_usd.toFixed(2)} of $${budget.budget_usd.toFixed(2)}`
    : `Spent: $${budget.spent_usd.toFixed(2)} (no cap)`;

/** `vtc status` as text. */
export const formatStatus = (status: StatusResult): string[] => {
  const { run } = status;
  const tasks = Object.entries(status.tasks_by_status)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${String(n)} ${state}`);
  return [
    `Run ${run.id}: ${run.track}, phase ${run.phase}${run.paused ? ", PAUSED" : ""}${run.finished_at === undefined ? "" : `, finished ${run.finished_at}`}`,
    `Tasks: ${tasks.length === 0 ? "none yet" : tasks.join(", ")}`,
    ...status.parked.map(
      (p) =>
        `  parked ${p.task}: ${p.reason}${p.risk_rule === undefined ? "" : ` (${p.risk_rule})`}`,
    ),
    ...status.features.map((f) => `Feature ${f.id}: ${f.status}`),
    ...(status.autopilot === undefined
      ? []
      : [
          `Autopilot: on (${String(status.autopilot.decisions)} decision${status.autopilot.decisions === 1 ? "" : "s"} taken for you, listed in the PR)`,
        ]),
    `Open escalations: ${String(status.open_escalations)}`,
    budgetLine(status.budget),
    ...usageLines(status.usage),
  ];
};

/** The repo's automation kill switch as `pause` / `resume` left it (AD-27 rule 7). */
const killSwitch = (paused: boolean): string =>
  paused ? "automation is paused" : "automation is on";

/**
 * A `pause` / `resume` result as text (contracts 5.4.0, reading 227 (2)): a run's state with the
 * kill switch when the engine reports it, or, with no run to act on, the kill switch alone. A call
 * without a run is a success: the switch took effect (reading 212(15)'s non-zero exit is gone).
 */
export const formatControl = (verb: string, result: ControlResult): string => {
  if (result.run === null)
    return `No run to ${verb === "paused" ? "pause" : "resume"}; ${killSwitch(result.automation_paused)}${result.automation_paused ? " (automatic issues and PRs stay off until vtc resume)" : ""}`;
  const automation =
    result.automation_paused === undefined ? "" : `; ${killSwitch(result.automation_paused)}`;
  return `Run ${result.run} ${verb}: ${result.paused ? "paused" : "running"} (phase ${result.phase})${automation}`;
};

const runFlags = (args: readonly string[]) =>
  parseFlags(args, { run: { type: "string" }, json: { type: "boolean" } }).values;

/** An engine tool error as the user should read it (the tool returns `{"error": "…"}`). */
export const toolErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed)
      return String(parsed.error);
  } catch {
    // not JSON
  }
  return message;
};

const withClient = async <T>(
  ctx: CommandContext,
  call: (client: Awaited<ReturnType<CommandContext["engine"]>>) => Promise<T>,
): Promise<T> => {
  const client = await ctx.engine();
  try {
    return await call(client);
  } catch (error) {
    throw new Error(toolErrorMessage(error), { cause: error });
  } finally {
    await client.close();
  }
};

export const status: CommandSpec = {
  name: "status",
  summary: "Show the current run",
  run: (args, ctx) =>
    guarded("status", ctx, async () => {
      const flags = runFlags(args);
      const result = await withClient(ctx, (c) =>
        c.call("status", flags.run === undefined ? {} : { run: flags.run }),
      );
      for (const line of flags.json === true
        ? [JSON.stringify(result, null, 2)]
        : formatStatus(result))
        ctx.io.out(line);
      return EXIT.ok;
    }),
};

const control = (tool: "pause" | "resume", verb: string, summary: string): CommandSpec => ({
  name: tool,
  summary,
  run: (args, ctx) =>
    guarded(tool, ctx, async () => {
      const flags = runFlags(args);
      const result = await withClient(ctx, (c) =>
        c.call(tool, flags.run === undefined ? {} : { run: flags.run }),
      );
      ctx.io.out(
        flags.json === true ? JSON.stringify(result, null, 2) : formatControl(verb, result),
      );
      return EXIT.ok;
    }),
});

/**
 * `vtc resume [--run <id>] [--adopt]`. `--adopt` continues here a run another clone started
 * (spine §5 reading 88): a human decision, so it goes only over the human connection, after the
 * terminal confirmation.
 */
const resumeCommand: CommandSpec = {
  name: "resume",
  summary: "Resume a paused or interrupted run; --adopt continues one another clone started",
  run: (args, ctx) =>
    guarded("resume", ctx, async () => {
      const flags = parseFlags(args, {
        run: { type: "string" },
        json: { type: "boolean" },
        adopt: { type: "boolean" },
      }).values;
      if (flags.adopt !== true) return control("resume", "resumed", "").run(args, ctx);
      if (flags.run === undefined) {
        ctx.io.err("vtc resume --adopt needs --run <id>: name the run to adopt");
        return EXIT.usage;
      }
      if (ctx.humanEngine === undefined)
        throw new Error("adopting a run needs an interactive terminal: run it yourself in one");
      const client = await ctx.humanEngine(
        `adopt run ${flags.run} from another clone onto this machine`,
      );
      let result: ControlResult;
      try {
        result = await client.call("resume", { run: flags.run, adopt: true });
      } catch (error) {
        throw new Error(toolErrorMessage(error), { cause: error });
      } finally {
        await client.close();
      }
      ctx.io.out(
        flags.json === true ? JSON.stringify(result, null, 2) : formatControl("adopted", result),
      );
      return EXIT.ok;
    }),
};

/** A `cancel` result as text: what stopped, and the worktrees left for the human. */
export const formatCancel = (result: CancelResult): string[] => [
  `Run ${result.run} cancelled (phase ${result.phase}): ${String(result.stopped_runs)} role run(s) stopped, ${String(result.closed_escalations)} open escalation(s) closed. The repo can start a new run.`,
  ...(result.worktrees_left.length === 0
    ? []
    : [
        `Worktrees left for you (keep what is worth keeping, then git worktree remove): ${result.worktrees_left.join(", ")}`,
      ]),
];

/** The first contracts version whose engine has the `cancel` tool. */
const CANCEL_SINCE = "5.13.0";

/**
 * `vtc cancel [--run <id>]` (spine §5 reading 268): ends a run started by mistake or no longer
 * wanted, as aborted. A human decision (`cancel` is a human-only tool), so it goes only over the
 * human connection, after the terminal confirmation.
 */
const cancelCommand: CommandSpec = {
  name: "cancel",
  summary:
    "End a run started by mistake (you confirm at the terminal); the repo can then start another",
  run: (args, ctx) =>
    guarded("cancel", ctx, async () => {
      const flags = runFlags(args);
      if (ctx.humanEngine === undefined)
        throw new Error("cancelling a run needs an interactive terminal: run it yourself in one");
      const client = await ctx.humanEngine(
        `cancel ${flags.run === undefined ? "the current run" : `run ${flags.run}`} (it ends as aborted; its worktrees and branches stay)`,
        CANCEL_SINCE,
      );
      let result: CancelResult;
      try {
        result = await client.call("cancel", flags.run === undefined ? {} : { run: flags.run });
      } catch (error) {
        throw new Error(toolErrorMessage(error), { cause: error });
      } finally {
        await client.close();
      }
      for (const line of flags.json === true
        ? [JSON.stringify(result, null, 2)]
        : formatCancel(result))
        ctx.io.out(line);
      return EXIT.ok;
    }),
};

export const pause = control("pause", "paused", "Kill switch: stop dispatching and merging");
export const cancel = cancelCommand;
export const resume = resumeCommand;
