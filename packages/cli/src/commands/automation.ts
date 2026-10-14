/**
 * Owner: cli+binary team. `vtc automation status [--json]` (spine AD-27 rule 7, D-ca): the repo's
 * Automation report (`GET /api/automation`, `AutomationReport`) from its engine, started when none
 * runs: whether automatic issues, PRs and upstream reports are on and why not, the open automatic
 * issues and PRs with their links, and the latest skips. It only reads; `vtc pause` stops
 * automation (D-bz). Every string the report carries is printed with control characters escaped.
 */
import {
  AutomationReportSchema,
  ENGINE_HTTP,
  type AutomationItem,
  type AutomationReport,
  type EngineDiscovery,
} from "@vtc/shared";
import { ensureDaemon } from "../daemon.js";
import { getFromEngine, type EngineHttpResponse } from "../engine-http.js";
import { printable } from "../human-gesture.js";
import { requireRepoRoot, requireVtcProject, UsageError } from "../repo.js";
import { runtime } from "../runtime.js";
import { readInstallToken } from "../token.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const USAGE = "usage: vtc automation status [--json]";

/** Skips shown, newest first. */
const RECENT_SKIPS = 10;

const onOff = (on: boolean): string => (on ? "on" : "off");

const isOpen = (item: AutomationItem): boolean =>
  item.issue?.state === "open" || item.pr?.state === "draft" || item.pr?.state === "open";

const itemLine = (item: AutomationItem): string => {
  const where =
    item.target.kind === "upstream" ? `${item.target.repo} (upstream)` : item.target.repo;
  const parts = [
    ...(item.issue === null
      ? []
      : [`issue #${String(item.issue.number)} ${item.issue.state} ${item.issue.url}`]),
    ...(item.pr === null
      ? []
      : [
          `PR #${String(item.pr.number)} ${item.pr.state}, evidence ${item.pr.evidence} ${item.pr.url}`,
        ]),
  ];
  return printable(`  ${where} ${item.kind} ${item.fingerprint.slice(0, 8)}: ${parts.join("; ")}`);
};

/** The report as text (D-ca): on/off with notes, open items with links, the latest skips. */
export const formatAutomation = (report: AutomationReport): string[] => {
  const open = report.items.filter(isOpen);
  const closed = report.items.length - open.length;
  const skips = [...report.skipped].sort((a, b) => b.at.localeCompare(a.at));
  const shown = skips.slice(0, RECENT_SKIPS);
  return [
    printable(
      `Automation: issues ${onOff(report.issues)}, PRs ${onOff(report.prs)}, upstream reports to ${report.upstream_repo} ${onOff(report.upstream)}; evidence hosting ${report.evidence_hosting}`,
    ),
    ...report.notes.map((n) => printable(`  note: ${n}`)),
    open.length === 0
      ? `Open: none${closed === 0 ? "" : ` (${String(closed)} closed not shown)`}`
      : `Open (${String(open.length)}${closed === 0 ? "" : `; ${String(closed)} closed not shown`}):`,
    ...open.map(itemLine),
    shown.length === 0
      ? "Recent skips: none"
      : `Recent skips (${shown.length === skips.length ? String(skips.length) : `${String(shown.length)} of ${String(skips.length)}`}):`,
    ...shown.map((s) =>
      printable(`  ${s.at} ${s.reason}${s.kind === undefined ? "" : ` (${s.kind})`}: ${s.detail}`),
    ),
  ];
};

export interface AutomationStatusDeps {
  /** The repo's live engine, started when none runs (`ensureDaemon`). */
  readonly discover: (vtcHome: string, repoRoot: string) => Promise<EngineDiscovery>;
  readonly token: (vtcHome: string) => string;
  readonly get: (port: number, path: string, token: string) => Promise<EngineHttpResponse>;
}

export const defaultAutomationStatusDeps = (): AutomationStatusDeps => ({
  discover: (vtcHome, repoRoot) =>
    ensureDaemon({ vtcHome, repoRoot, selfCommand: runtime().selfCommand }),
  token: readInstallToken,
  get: (port, path, token) => getFromEngine(port, path, token),
});

const readReport = async (
  d: AutomationStatusDeps,
  vtcHome: string,
  repoRoot: string,
): Promise<AutomationReport> => {
  const engine = await d.discover(vtcHome, repoRoot);
  const route = ENGINE_HTTP.routes.automation;
  const response = await d.get(engine.port, route.path, d.token(vtcHome));
  if (response.status === 0)
    throw new Error(`the engine on port ${String(engine.port)} did not answer`);
  if (response.status === 404)
    throw new Error(
      "the running engine has no automation report (it predates contracts 5.0.0): run vtc engine --stop in this repo, then try again",
    );
  if (response.status !== 200)
    throw new Error(`the engine answered HTTP ${String(response.status)} for ${route.path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(response.body);
  } catch {
    raw = null;
  }
  const parsed = AutomationReportSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `the engine's automation report does not parse: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  return parsed.data;
};

export const createAutomationCommand = (
  deps: () => AutomationStatusDeps = defaultAutomationStatusDeps,
): CommandSpec => ({
  name: "automation",
  summary:
    "status: show automatic issues and PRs for this repo (on/off and why, open items with links, recent skips)",
  run: (args, ctx) =>
    guarded("automation", ctx, async () => {
      const { values, positionals } = parseFlags(args, { json: { type: "boolean" } }, true);
      if (positionals.length !== 1 || positionals[0] !== "status") throw new UsageError(USAGE);
      const repoRoot = await requireRepoRoot(ctx.cwd);
      requireVtcProject(repoRoot);
      const report = await readReport(deps(), ctx.vtcHome, repoRoot);
      for (const line of values.json === true
        ? [JSON.stringify(report, null, 2)]
        : formatAutomation(report))
        ctx.io.out(line);
      return EXIT.ok;
    }),
});

export const command = createAutomationCommand();
