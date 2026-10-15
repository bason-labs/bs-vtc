/**
 * The effective routing as `vtc doctor` and `vtc config` show it (H-9; spine §5 readings 218, 220
 * and 224; owner: cli+binary team):
 * - the routing table (`DEFAULT_ROUTING_TABLE`, with any per-role `roles` overrides, D-cn);
 * - the project's `routing` (`routingFor(project.yaml)`: `start`, `min_tier`, `max_tier`) and the
 *   start tier each size and risk class gets inside that range (QA in author mode never below
 *   `QA_AUTHOR_MIN_TIER`);
 * - per host, the tier → model map: `project.yaml` `hosts.models` over the engine's built-in
 *   `DEFAULT_TIER_MODELS` (Codex's from its model docs since D-co); a tier with no model id varies
 *   the reasoning effort only (`TIER_EFFORT_WITHOUT_MODEL`);
 * - the user's Lookback replay pace (`~/.vtc/config.yaml` `lookback`, `lookbackPaceFor`), with the
 *   cap that applies now for each host whose weekly window the repo's running engine reports.
 *
 * It only reads. The start tier of a cell is the table's tier for the size, raised to
 * `tagged_floor` for a task with a risk tag and to `high_floor` for a high-risk one
 * (`taskRiskClass`), then held in the project's range: the rule of reading 218 (2) and (4), read
 * through the shared `routedStartTier` engine core's routing function dispatches with.
 *
 * `project.yaml` is repo content: every string taken from it is printed with its control
 * characters escaped (`printable`).
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { core } from "@vtc/engine";
import {
  clampTier,
  DEFAULT_ROUTING_TABLE,
  HOST_IDS,
  lookbackPaceFor,
  LOOKBACK_LIMITS,
  parsePersisted,
  ProjectConfigSchema,
  QA_AUTHOR_MIN_TIER,
  routedStartTier,
  routingFor,
  RoutingConfigSchema,
  TIER_EFFORT_WITHOUT_MODEL,
  TIER_ORDER,
  UserConfigSchema,
  type Effort,
  type HostId,
  type ModelTier,
  type ProjectConfig,
  type RoutingConfig,
  type RoutingRoleOverride,
  type RoutingStart,
  type RoutingTable,
  type TaskRiskClass,
  type UserConfig,
} from "@vtc/shared";
import type { DoctorCheck } from "./doctor-checks.js";
import { printable } from "./human-gesture.js";
import type { UserConfigRead } from "./user-config.js";

type Size = "S" | "M" | "L";
const SIZES: readonly Size[] = ["S", "M", "L"];
const RISKS: readonly TaskRiskClass[] = ["none", "tagged", "high"];

type HostModels = NonNullable<ProjectConfig["hosts"]["models"]>;

// ------------------------------------------------------------------ reading

/** `.vtc/project.yaml` as the routing view reads it. */
export type ProjectRoutingRead =
  | { readonly kind: "none" }
  | {
      readonly kind: "read";
      /** The `routing` section, when it is valid (absent: unset). */
      readonly routing: RoutingConfig | undefined;
      /** Why the `routing` section is invalid, or `null`. */
      readonly routingError: string | null;
      /** `hosts.models`, when the whole file loads. */
      readonly models: HostModels | undefined;
      /** Why the whole file does not load, or `null`. */
      readonly configError: string | null;
    };

const issuesOf = (error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string =>
  error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sectionOf = (doc: unknown, key: string): unknown =>
  typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>)[key] : undefined;

/**
 * The project's `routing` and `hosts.models` from the working tree's `.vtc/project.yaml`; `none`
 * outside a VTC project. The `routing` section is checked on its own, so an inverted range is named
 * even when other parts of the file are broken too.
 */
export const readProjectRouting = (repoRoot: string | null): ProjectRoutingRead => {
  if (repoRoot === null) return { kind: "none" };
  const path = join(repoRoot, core.PROJECT_CONFIG_PATH);
  try {
    if (!lstatSync(path).isFile()) return { kind: "none" };
  } catch {
    return { kind: "none" };
  }
  let text: string;
  let doc: unknown;
  try {
    text = readFileSync(path, "utf8");
    doc = core.parseYaml(text) ?? {};
  } catch (error) {
    return {
      kind: "read",
      routing: undefined,
      routingError: null,
      models: undefined,
      configError: message(error),
    };
  }
  const rawRouting = sectionOf(doc, "routing");
  const routing = rawRouting === undefined ? null : parsePersisted(RoutingConfigSchema, rawRouting);
  const whole = parsePersisted(ProjectConfigSchema, doc);
  return {
    kind: "read",
    routing: routing?.success === true ? routing.data : undefined,
    routingError: routing === null || routing.success ? null : issuesOf(routing.error),
    models: whole.success ? whole.data.hosts.models : undefined,
    configError: whole.success ? null : issuesOf(whole.error),
  };
};

/** Each host's weekly window left, as the repo's running engine reports it (`GET /api/usage`). */
export interface WeeklyWindows {
  /** `engine`: read from the running engine; `no_engine`: none runs for this repo. */
  readonly source: "engine" | "no_engine";
  readonly hosts: readonly { readonly host: HostId; readonly remaining_pct: number | null }[];
}

export const NO_WEEKLY: WeeklyWindows = { source: "no_engine", hosts: [] };

// --------------------------------------------------------------------- view

export type StartTiers = Readonly<Record<Size, Readonly<Record<TaskRiskClass, ModelTier>>>>;

export interface TierModel {
  readonly model: string | null;
  /** `project`: `project.yaml` `hosts.models`; `built_in`: the engine's map; `null`: none. */
  readonly source: "project" | "built_in" | null;
  /** The reasoning effort a tier with no model id runs at (D-co's interim rule). */
  readonly effort?: Effort;
}

export interface RoutingView {
  readonly table: RoutingTable;
  readonly project: {
    /** A VTC project is here. */
    readonly found: boolean;
    readonly start: RoutingStart;
    readonly min_tier: ModelTier;
    readonly max_tier: ModelTier;
    /** `project.yaml` sets `routing`. */
    readonly set: boolean;
    /** Why `project.yaml` `routing` is invalid (the engine refuses the file), or `null`. */
    readonly error: string | null;
    /** Why the rest of `project.yaml` does not load (its `hosts.models` are not read), or `null`. */
    readonly config_error: string | null;
  };
  /** The start tier per size and risk class; `null` with `start: role` or an invalid `routing`. */
  readonly start_tiers: StartTiers | null;
  /** The same for each role the table's `roles` overrides. */
  readonly role_start_tiers: Readonly<Record<string, StartTiers>>;
  readonly qa_author_min_tier: ModelTier;
  readonly models: Readonly<Record<HostId, Readonly<Record<ModelTier, TierModel>>>>;
  readonly lookback: {
    readonly failure_tasks: number;
    readonly regression_tasks: number;
    readonly max_trials_per_retro: number;
    /** The boosted cap as it applies: never below the base cap. */
    readonly max_trials_per_retro_boosted: number;
    readonly boost_above_weekly_pct: number;
    /** Why `~/.vtc/config.yaml` `lookback` is invalid, or `null`. */
    readonly error: string | null;
    /** The boosted cap the user set below the base cap, which turns the boost off; else absent. */
    readonly boosted_below_base?: { readonly boosted: number; readonly base: number };
    readonly weekly: {
      readonly source: WeeklyWindows["source"];
      readonly hosts: readonly {
        readonly host: HostId;
        readonly remaining_pct: number | null;
        readonly max_trials_per_retro: number;
      }[];
    };
  };
}

/**
 * The start tiers of the table (one role's cells when `role` names one), held in `[min, max]`: the
 * shared rule (`routedStartTier`, contracts 5.5.0) engine core's router dispatches with.
 */
const startTiersOf = (
  table: RoutingTable,
  role: string | undefined,
  min: ModelTier,
  max: ModelTier,
): StartTiers => {
  const row = (size: Size) =>
    Object.fromEntries(
      RISKS.map((r) => [r, clampTier(routedStartTier(table, role, size, r), min, max)]),
    ) as Record<TaskRiskClass, ModelTier>;
  return { S: row("S"), M: row("M"), L: row("L") };
};

const modelsOf = (models: HostModels | undefined): RoutingView["models"] =>
  Object.fromEntries(
    HOST_IDS.map((host) => [
      host,
      Object.fromEntries(
        TIER_ORDER.map((tier): [ModelTier, TierModel] => {
          const own = models?.[host]?.[tier];
          if (own !== undefined) return [tier, { model: own, source: "project" }];
          const builtIn = core.DEFAULT_TIER_MODELS[host][tier];
          if (builtIn !== undefined) return [tier, { model: builtIn, source: "built_in" }];
          return [tier, { model: null, source: null, effort: TIER_EFFORT_WITHOUT_MODEL[tier] }];
        }),
      ),
    ]),
  ) as RoutingView["models"];

/** The user's `lookback` section, checked on its own, and why it is invalid. */
const userLookbackOf = (
  user: UserConfigRead,
): { readonly lookback: UserConfig["lookback"]; readonly error: string | null } => {
  if (user.ok) return { lookback: user.config.lookback, error: null };
  const raw = sectionOf(user.raw, "lookback");
  if (raw === undefined) return { lookback: undefined, error: null };
  const parsed = parsePersisted(UserConfigSchema.shape.lookback, raw);
  return parsed.success
    ? { lookback: parsed.data, error: null }
    : { lookback: undefined, error: issuesOf(parsed.error) };
};

/** The effective routing (pure). `table` defaults to `DEFAULT_ROUTING_TABLE`. */
export const routingView = (input: {
  readonly project: ProjectRoutingRead;
  readonly user: UserConfigRead;
  readonly weekly: WeeklyWindows;
  readonly table?: RoutingTable;
}): RoutingView => {
  const table = input.table ?? DEFAULT_ROUTING_TABLE;
  const read = input.project.kind === "read" ? input.project : null;
  const routing = routingFor(read?.routing === undefined ? undefined : { routing: read.routing });
  const error = read?.routingError ?? null;
  const ruleOn = routing.start === "difficulty" && error === null;
  const { lookback, error: lookbackError } = userLookbackOf(input.user);
  const config = { lookback };
  const base = lookbackPaceFor(config, null);
  const boosted = lookbackPaceFor(config, Number.POSITIVE_INFINITY).maxTrialsPerRetro;
  const setBoosted = lookback?.max_trials_per_retro_boosted;
  return {
    table,
    project: {
      found: read !== null,
      start: routing.start,
      min_tier: routing.min,
      max_tier: routing.max,
      set: read?.routing !== undefined,
      error,
      config_error: error === null ? (read?.configError ?? null) : null,
    },
    start_tiers: ruleOn ? startTiersOf(table, undefined, routing.min, routing.max) : null,
    role_start_tiers: ruleOn
      ? Object.fromEntries(
          Object.keys(table.roles ?? {}).map((role) => [
            role,
            startTiersOf(table, role, routing.min, routing.max),
          ]),
        )
      : {},
    qa_author_min_tier: QA_AUTHOR_MIN_TIER,
    models: modelsOf(read?.models),
    lookback: {
      failure_tasks: base.failureTasks,
      regression_tasks: base.regressionTasks,
      max_trials_per_retro: base.maxTrialsPerRetro,
      max_trials_per_retro_boosted: boosted,
      boost_above_weekly_pct:
        lookback?.boost_above_weekly_pct ?? LOOKBACK_LIMITS.boostAboveWeeklyPct,
      error: lookbackError,
      ...(setBoosted !== undefined && setBoosted < base.maxTrialsPerRetro
        ? { boosted_below_base: { boosted: setBoosted, base: base.maxTrialsPerRetro } }
        : {}),
      weekly: {
        source: input.weekly.source,
        hosts: input.weekly.hosts.map((h) => ({
          ...h,
          max_trials_per_retro: lookbackPaceFor(config, h.remaining_pct).maxTrialsPerRetro,
        })),
      },
    },
  };
};

// ------------------------------------------------------------------- text

const PROJECT_ROUTING = `${core.PROJECT_CONFIG_PATH} routing`;

const overrideText = (o: RoutingRoleOverride): string =>
  [
    ...SIZES.flatMap((s) =>
      o.by_size?.[s] === undefined ? [] : [`by_size ${s} ${o.by_size[s] ?? ""}`],
    ),
    ...(o.tagged_floor === undefined ? [] : [`tagged_floor ${o.tagged_floor}`]),
    ...(o.high_floor === undefined ? [] : [`high_floor ${o.high_floor}`]),
  ].join("; ");

/** The table's rule in one line. */
const ruleText = (table: RoutingTable): string =>
  `S ${table.by_size.S}, M ${table.by_size.M}, L ${table.by_size.L}; any risk tag at least ${table.tagged_floor}; high risk (${table.high_risk_tags.join(", ")}, or risk: high) ${table.high_floor}`;

const rangeText = (view: RoutingView): string =>
  `tiers ${view.project.min_tier}..${view.project.max_tier} (${view.project.set ? PROJECT_ROUTING : `${PROJECT_ROUTING} unset`})`;

const hostModelsText = (host: HostId, tiers: RoutingView["models"][HostId]): string => {
  if (TIER_ORDER.every((t) => tiers[t].model === null))
    return `${host}: no model id for any tier, so a tier varies the reasoning effort only (${TIER_ORDER.map((t) => `${t} ${tiers[t].effort ?? ""}`).join(", ")}) until its ids are set (D-co)`;
  return `${host}: ${TIER_ORDER.map((t) => {
    const m = tiers[t];
    return m.model === null
      ? `${t} no model id (effort ${m.effort ?? ""})`
      : `${t} ${printable(m.model)}${m.source === "project" ? " (project.yaml)" : ""}`;
  }).join(", ")}`;
};

const paceText = (view: RoutingView): string => {
  const l = view.lookback;
  const boost =
    l.max_trials_per_retro_boosted > l.max_trials_per_retro
      ? `, ${String(l.max_trials_per_retro_boosted)} while the Lead host's weekly window has more than ${String(l.boost_above_weekly_pct)}% left`
      : "";
  return `${String(l.failure_tasks)} recent failures and ${String(l.regression_tasks)} regression tasks per replay; ${String(l.max_trials_per_retro)} trials per RETRO${boost}`;
};

const weeklyText = (view: RoutingView): string => {
  const w = view.lookback.weekly;
  if (w.source === "no_engine" || w.hosts.length === 0)
    return `weekly window: unknown (${w.source === "no_engine" ? "no engine is running for this repo" : "the engine has no reading yet"}), so the base cap applies`;
  return `now: ${w.hosts
    .map((h, i) =>
      h.remaining_pct === null
        ? `${h.host} unknown: ${String(h.max_trials_per_retro)}`
        : `${h.host} ${String(Math.round(h.remaining_pct))}% left: ${String(h.max_trials_per_retro)}${i === 0 ? " trials per RETRO" : ""}`,
    )
    .join("; ")}`;
};

const gridLines = (tiers: StartTiers, indent: string): string[] => [
  `${indent}      none    tagged  high`,
  ...SIZES.map((s) =>
    `${indent}  ${s}   ${RISKS.map((r) => tiers[s][r].padEnd(8)).join("")}`.trimEnd(),
  ),
];

/** A `project.yaml` that does not load, apart from its `routing` section. */
const notLoading = (error: string): string =>
  `${core.PROJECT_CONFIG_PATH} does not load (${printable(error)}), so its hosts.models are not shown and the engine refuses it`;

/** `vtc config` as text. */
export const formatRoutingView = (view: RoutingView): string[] => {
  const roles = Object.entries(view.table.roles ?? {});
  const routingLines = (): string[] => {
    if (view.project.error !== null)
      return [
        `  ${PROJECT_ROUTING} is invalid: ${printable(view.project.error)} (the engine refuses this project.yaml)`,
      ];
    if (view.start_tiers === null)
      return [
        `  start: role: each per-task role starts on its own role.yaml tier (the difficulty rule is off); ${rangeText(view)}`,
      ];
    return [
      `  start tier by task size and risk, ${rangeText(view)}:`,
      ...gridLines(view.start_tiers, "  "),
      ...Object.entries(view.role_start_tiers).flatMap(([role, tiers]) => [
        `  ${role}:`,
        ...gridLines(tiers, "  "),
      ]),
      `  QA in author mode never starts below ${view.qa_author_min_tier}. After 2 failed rounds a role goes one tier up; reviewers go one tier down at 70% of the budget; both stay in the range.`,
    ];
  };
  return [
    ...(view.project.config_error === null ? [] : [notLoading(view.project.config_error)]),
    "Routing (H-9): per-task roles start on the tier the task's difficulty picks",
    `  table v${String(view.table.v)}: ${ruleText(view.table)}`,
    roles.length === 0
      ? "  role overrides: none"
      : `  role overrides: ${roles.map(([role, o]) => `${role}: ${overrideText(o)}`).join("; ")}`,
    ...(view.project.found
      ? routingLines()
      : [
          "  no VTC project here: a project's routing.min_tier / max_tier would hold every tier in its range",
          ...gridLines(startTiersOf(view.table, undefined, "low", "top"), "  "),
        ]),
    "Models per tier (project.yaml hosts.models over the built-in map; a role.yaml model id applies on the role's own tier only):",
    ...HOST_IDS.map((host) => `  ${hostModelsText(host, view.models[host])}`),
    "Lookback replay pace (~/.vtc/config.yaml lookback):",
    ...(view.lookback.error === null
      ? []
      : [`  invalid: ${printable(view.lookback.error)} (the defaults are shown)`]),
    `  ${paceText(view)}`,
    `  ${weeklyText(view)}`,
  ];
};

// ----------------------------------------------------------------- doctor

/** Doctor's `routing`, `models` and `lookback` lines; an invalid section fails. */
export const routingChecks = (view: RoutingView): DoctorCheck[] => {
  const routing: DoctorCheck =
    view.project.error !== null
      ? {
          name: "routing",
          status: "fail",
          detail: `${PROJECT_ROUTING}: ${printable(view.project.error)}`,
        }
      : !view.project.found
        ? {
            name: "routing",
            status: "info",
            detail: `per-task roles start by task difficulty: ${ruleText(view.table)} (no VTC project here)`,
          }
        : view.start_tiers === null
          ? {
              name: "routing",
              status: "ok",
              detail: `start: role: per-task roles start on their own role.yaml tier (the difficulty rule is off); ${rangeText(view)}`,
            }
          : {
              name: "routing",
              status: "ok",
              detail: `per-task roles start by task difficulty: ${ruleText(view.table)}; ${rangeText(view)}; QA in author mode never below ${view.qa_author_min_tier}`,
            };
  const project = view.project.config_error;
  const routingLine: DoctorCheck =
    project === null || routing.status === "fail"
      ? routing
      : { ...routing, status: "warn", detail: `${routing.detail}; ${notLoading(project)}` };
  const models: DoctorCheck = {
    name: "models",
    status: "info",
    detail: HOST_IDS.map((host) => hostModelsText(host, view.models[host])).join("; "),
  };
  const l = view.lookback;
  const lookback: DoctorCheck =
    l.error !== null
      ? {
          name: "lookback",
          status: "fail",
          detail: `~/.vtc/config.yaml lookback: ${printable(l.error)}`,
        }
      : l.boosted_below_base !== undefined
        ? {
            name: "lookback",
            status: "warn",
            detail: `${paceText(view)}; lookback.max_trials_per_retro_boosted (${String(l.boosted_below_base.boosted)}) is below max_trials_per_retro (${String(l.boosted_below_base.base)}), so the boost is off`,
          }
        : { name: "lookback", status: "ok", detail: `${paceText(view)}; ${weeklyText(view)}` };
  return [routingLine, models, lookback];
};
