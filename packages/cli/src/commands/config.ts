/**
 * Owner: cli+binary team. `vtc config [--json]` (H-9 routing visibility; spine §5 readings 218,
 * 220 and 224): shows, and never changes, the effective routing of the repo it runs in
 * (`routing-view.ts`): the routing table and its role overrides, the project's `routing` range with
 * each size and risk class's start tier, each host's tier → model map (effort only where a tier
 * has no model id), and the user's Lookback replay pace with the cap that applies now. The weekly
 * window comes from the repo's running engine (`GET /api/usage`); none is started for it. Exits 1
 * when `project.yaml` does not load (its `routing` above all) or `~/.vtc/config.yaml` `lookback`
 * is invalid.
 */
import { ENGINE_HTTP, remainingPct, UsageReportSchema, type EngineDiscovery } from "@vtc/shared";
import { liveDaemon } from "../daemon.js";
import { getFromEngine, type EngineHttpResponse } from "../engine-http.js";
import { findRepoRoot, UsageError } from "../repo.js";
import {
  formatRoutingView,
  NO_WEEKLY,
  readProjectRouting,
  routingView,
  type ProjectRoutingRead,
  type WeeklyWindows,
} from "../routing-view.js";
import { readInstallToken } from "../token.js";
import { readUserConfig, type UserConfigRead } from "../user-config.js";
import { jsonText } from "./automation.js";
import type { CommandContext, CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const USAGE = "usage: vtc config [--json]";

/** How {@link readWeeklyWindows} reaches the repo's engine. */
export interface WeeklyDeps {
  /** The repo's live engine, or `null`: never started for this. */
  readonly live: (vtcHome: string, repoRoot: string) => Promise<EngineDiscovery | null>;
  readonly token: (vtcHome: string) => string;
  readonly get: (port: number, path: string, token: string) => Promise<EngineHttpResponse>;
}

export const defaultWeeklyDeps = (): WeeklyDeps => ({
  live: (vtcHome, repoRoot) => liveDaemon(vtcHome, repoRoot),
  token: readInstallToken,
  get: (port, path, token) => getFromEngine(port, path, token, 3_000),
});

/**
 * Each host's weekly window left, from the repo's running engine's usage report; `no_engine`
 * without a repo or a live engine, and no host when the engine does not answer with a report.
 */
export const readWeeklyWindows = async (
  vtcHome: string,
  repoRoot: string | null,
  deps: WeeklyDeps = defaultWeeklyDeps(),
): Promise<WeeklyWindows> => {
  if (repoRoot === null) return NO_WEEKLY;
  const engine = await deps.live(vtcHome, repoRoot).catch(() => null);
  if (engine === null) return NO_WEEKLY;
  const none: WeeklyWindows = { source: "engine", hosts: [] };
  try {
    const response = await deps.get(
      engine.port,
      ENGINE_HTTP.routes.usage.path,
      deps.token(vtcHome),
    );
    if (response.status !== 200) return none;
    const report = UsageReportSchema.safeParse(JSON.parse(response.body));
    if (!report.success) return none;
    return {
      source: "engine",
      hosts: report.data.hosts.map((h) => {
        const weekly = h.windows.find((w) => w.kind === "weekly");
        return { host: h.host, remaining_pct: weekly === undefined ? null : remainingPct(weekly) };
      }),
    };
  } catch {
    return none;
  }
};

/** What `vtc config` reads. */
export interface ConfigCommandEnv {
  readonly userConfig: () => UserConfigRead;
  readonly project: () => Promise<ProjectRoutingRead>;
  readonly weekly: () => Promise<WeeklyWindows>;
}

export const defaultConfigEnv = (ctx: CommandContext): ConfigCommandEnv => ({
  userConfig: () => readUserConfig(ctx.vtcHome),
  project: async () => readProjectRouting(await findRepoRoot(ctx.cwd)),
  weekly: async () => readWeeklyWindows(ctx.vtcHome, await findRepoRoot(ctx.cwd)),
});

export const createConfigCommand = (
  env: (ctx: CommandContext) => ConfigCommandEnv = defaultConfigEnv,
): CommandSpec => ({
  name: "config",
  summary:
    "Show the effective routing (tier table, the project's range, models per tier, Lookback replay pace); --json for JSON. Changes nothing",
  run: (args, ctx) =>
    guarded("config", ctx, async () => {
      const { values, positionals } = parseFlags(args, { json: { type: "boolean" } }, true);
      if (positionals.length > 0) throw new UsageError(USAGE);
      const e = env(ctx);
      const [project, weekly] = await Promise.all([e.project(), e.weekly()]);
      const view = routingView({ project, user: e.userConfig(), weekly });
      for (const line of values.json === true ? [jsonText(view)] : formatRoutingView(view))
        ctx.io.out(line);
      const valid =
        view.project.error === null &&
        view.project.config_error === null &&
        view.lookback.error === null;
      return valid ? EXIT.ok : EXIT.failed;
    }),
});

export const command = createConfigCommand();
