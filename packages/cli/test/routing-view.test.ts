/**
 * H-9 routing visibility (spine §5 readings 218, 220 and 224): what `vtc doctor` and `vtc config`
 * show of the effective routing: the routing table (`DEFAULT_ROUTING_TABLE`, any `roles`
 * overrides), the project's `routing` (`routingFor`), each host's tier → model map (the engine's
 * built-in `DEFAULT_TIER_MODELS` under `project.yaml` `hosts.models`; a tier with no model id varies
 * effort only, `TIER_EFFORT_WITHOUT_MODEL`), and the user's Lookback replay pace
 * (`lookbackPaceFor`, with the weekly window when an engine reports it). Doctor fails an invalid
 * `~/.vtc/config.yaml` `lookback` and a `project.yaml` `routing` whose `min_tier` is above its
 * `max_tier`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { core } from "@vtc/engine";
import { DEFAULT_ROUTING_TABLE, RoutingTableSchema, type RoutingTable } from "@vtc/shared";
import {
  formatRoutingView,
  NO_WEEKLY,
  readProjectRouting,
  routingChecks,
  routingView,
  type ProjectRoutingRead,
  type WeeklyWindows,
} from "../src/routing-view.js";
import { createDoctorCommand } from "../src/commands/doctor.js";
import type { Exec } from "../src/process.js";
import { readUserConfig, type UserConfigRead } from "../src/user-config.js";
import { capture, cleanupDirs, tempDir, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

const userYaml = (yaml: string): UserConfigRead => {
  const home = tempHome();
  writeFileSync(join(home, "config.yaml"), yaml);
  return readUserConfig(home);
};

const projectYaml = (yaml: string): ProjectRoutingRead => {
  const repo = tempDir();
  mkdirSync(join(repo, ".vtc"));
  writeFileSync(join(repo, core.PROJECT_CONFIG_PATH), yaml);
  return readProjectRouting(repo);
};

const DEFAULT_USER = userYaml("version: 1\n");
const DEFAULT_PROJECT = projectYaml("version: 1\n");

describe("reading the project's routing", () => {
  it("is none outside a VTC project", () => {
    expect(readProjectRouting(null)).toEqual({ kind: "none" });
    expect(readProjectRouting(tempDir())).toEqual({ kind: "none" });
  });

  it("reads routing and hosts.models, and keeps a bad routing section apart from the rest", () => {
    const read = projectYaml(
      "version: 1\nrouting:\n  start: role\n  max_tier: mid\nhosts:\n  models:\n    codex:\n      top: gpt-x\n",
    );
    expect(read).toEqual({
      kind: "read",
      routing: { start: "role", max_tier: "mid" },
      routingError: null,
      models: { codex: { top: "gpt-x" } },
      configError: null,
    });
    const inverted = projectYaml("version: 1\nrouting:\n  min_tier: top\n  max_tier: low\n");
    expect(inverted.kind).toBe("read");
    if (inverted.kind !== "read") return;
    expect(inverted.routing).toBeUndefined();
    expect(inverted.routingError).toMatch(/min_tier may not be above routing\.max_tier/);
    expect(inverted.configError).not.toBeNull();
    const broken = projectYaml("version: 1\nrouting: [\n");
    expect(broken.kind === "read" && broken.configError).toBeTruthy();
  });
});

describe("the routing view (H-9, D-cm)", () => {
  it("shows the table, the full default range and each size and risk class's start tier", () => {
    const view = routingView({ project: DEFAULT_PROJECT, user: DEFAULT_USER, weekly: NO_WEEKLY });
    expect(view.table).toEqual(DEFAULT_ROUTING_TABLE);
    expect(view.project).toEqual({
      found: true,
      start: "difficulty",
      min_tier: "low",
      max_tier: "top",
      set: false,
      error: null,
      config_error: null,
    });
    expect(view.start_tiers).toEqual({
      S: { none: "low", tagged: "mid", high: "top" },
      M: { none: "mid", tagged: "mid", high: "top" },
      L: { none: "top", tagged: "top", high: "top" },
    });
    expect(view.qa_author_min_tier).toBe("mid");
    expect(view.role_start_tiers).toEqual({});
  });

  it("holds every start tier inside the project's range, and none with start: role", () => {
    const narrow = routingView({
      project: projectYaml("version: 1\nrouting:\n  min_tier: mid\n  max_tier: mid\n"),
      user: DEFAULT_USER,
      weekly: NO_WEEKLY,
    });
    expect(narrow.start_tiers).toEqual({
      S: { none: "mid", tagged: "mid", high: "mid" },
      M: { none: "mid", tagged: "mid", high: "mid" },
      L: { none: "mid", tagged: "mid", high: "mid" },
    });
    const off = routingView({
      project: projectYaml("version: 1\nrouting:\n  start: role\n"),
      user: DEFAULT_USER,
      weekly: NO_WEEKLY,
    });
    expect(off.start_tiers).toBeNull();
    expect(formatRoutingView(off).join("\n")).toMatch(
      /start: role: each per-task role starts on its own role\.yaml tier \(the difficulty rule is off\)/,
    );
  });

  it("applies a role's own cells from the table's roles overrides (D-cn)", () => {
    const table: RoutingTable = RoutingTableSchema.parse({
      ...DEFAULT_ROUTING_TABLE,
      roles: { spec_verifier: { by_size: { S: "mid" }, high_floor: "mid" } },
    });
    const view = routingView({
      project: DEFAULT_PROJECT,
      user: DEFAULT_USER,
      weekly: NO_WEEKLY,
      table,
    });
    expect(view.role_start_tiers).toEqual({
      spec_verifier: {
        S: { none: "mid", tagged: "mid", high: "mid" },
        M: { none: "mid", tagged: "mid", high: "mid" },
        L: { none: "top", tagged: "top", high: "top" },
      },
    });
    expect(formatRoutingView(view).join("\n")).toMatch(
      /spec_verifier: by_size S mid; high_floor mid/,
    );
  });

  it("maps each host's tiers to model ids: the project's over the built-in, effort only without one", () => {
    const view = routingView({
      project: projectYaml("version: 1\nhosts:\n  models:\n    claude-code:\n      low: sonnet\n"),
      user: DEFAULT_USER,
      weekly: NO_WEEKLY,
    });
    expect(view.models["claude-code"]).toEqual({
      low: { model: "sonnet", source: "project" },
      mid: { model: "sonnet", source: "built_in" },
      top: { model: "opus", source: "built_in" },
    });
    // D-co (spine §5 reading 228): the docs' Codex ids are built in
    expect(view.models.codex).toEqual({
      low: { model: "gpt-6-luna", source: "built_in" },
      mid: { model: "gpt-6.1-sol", source: "built_in" },
      top: { model: "gpt-6-astra", source: "built_in" },
    });
    const text = formatRoutingView(view).join("\n");
    expect(text).toMatch(/claude-code: low sonnet \(project\.yaml\), mid sonnet, top opus/);
    expect(text).toMatch(/codex: low gpt-6-luna, mid gpt-6\.1-sol, top gpt-6-astra/);
  });

  it("shows the Lookback pace with the base and boosted caps, and the cap that applies now", () => {
    const weekly: WeeklyWindows = {
      source: "engine",
      hosts: [
        { host: "claude-code", remaining_pct: 72 },
        { host: "codex", remaining_pct: null },
      ],
    };
    const view = routingView({ project: { kind: "none" }, user: DEFAULT_USER, weekly });
    expect(view.lookback).toEqual({
      failure_tasks: 6,
      regression_tasks: 6,
      max_trials_per_retro: 24,
      max_trials_per_retro_boosted: 36,
      boost_above_weekly_pct: 50,
      error: null,
      weekly: {
        source: "engine",
        hosts: [
          { host: "claude-code", remaining_pct: 72, max_trials_per_retro: 36 },
          { host: "codex", remaining_pct: null, max_trials_per_retro: 24 },
        ],
      },
    });
    const text = formatRoutingView(view).join("\n");
    expect(text).toMatch(
      /6 recent failures and 6 regression tasks per replay; 24 trials per RETRO, 36 while the Lead host's weekly window has more than 50% left/,
    );
    expect(text).toMatch(/claude-code 72% left: 36 trials per RETRO; codex unknown: 24/);
    expect(
      formatRoutingView(
        routingView({ project: { kind: "none" }, user: DEFAULT_USER, weekly: NO_WEEKLY }),
      ).join("\n"),
    ).toMatch(
      /weekly window: unknown \(no engine is running for this repo\), so the base cap applies/,
    );
  });

  it("takes the user's lookback keys, and a boosted cap below the base never lowers it", () => {
    const view = routingView({
      project: { kind: "none" },
      user: userYaml(
        "version: 1\nlookback:\n  replay_failure_tasks: 4\n  max_trials_per_retro: 30\n  max_trials_per_retro_boosted: 20\n  boost_above_weekly_pct: 80\n",
      ),
      weekly: NO_WEEKLY,
    });
    expect(view.lookback).toMatchObject({
      failure_tasks: 4,
      regression_tasks: 6,
      max_trials_per_retro: 30,
      max_trials_per_retro_boosted: 30,
      boost_above_weekly_pct: 80,
    });
  });
});

describe("doctor's routing checks", () => {
  const checks = (project: ProjectRoutingRead, user: UserConfigRead = DEFAULT_USER) =>
    routingChecks(routingView({ project, user, weekly: NO_WEEKLY }));

  it("reports routing, models and the Lookback pace, failing none of them by default", () => {
    const list = checks(DEFAULT_PROJECT);
    expect(list.map((c) => [c.name, c.status])).toEqual([
      ["routing", "ok"],
      ["models", "info"],
      ["lookback", "ok"],
    ]);
    expect(list[0]?.detail).toBe(
      "per-task roles start by task difficulty: S low, M mid, L top; any risk tag at least mid; high risk (auth, payments, data, security, migration, or risk: high) top; tiers low..top (.vtc/project.yaml routing unset); QA in author mode never below mid",
    );
    expect(list[1]?.detail).toMatch(
      /^claude-code: low haiku, mid sonnet, top opus; codex: low gpt-6-luna, mid gpt-6\.1-sol, top gpt-6-astra/,
    );
    expect(checks({ kind: "none" })[0]).toMatchObject({ status: "info" });
  });

  it("warns when project.yaml does not load elsewhere: its hosts.models are not read", () => {
    const broken = projectYaml("version: 1\nconcurrency: 9\nrouting:\n  max_tier: mid\n");
    const view = routingView({ project: broken, user: DEFAULT_USER, weekly: NO_WEEKLY });
    expect(view.project.config_error).toMatch(/concurrency/);
    expect(view.project.max_tier).toBe("mid");
    const [routing] = routingChecks(view);
    expect(routing?.status).toBe("warn");
    expect(routing?.detail).toMatch(
      /; \.vtc\/project\.yaml does not load \(concurrency: .*\), so its hosts\.models are not shown and the engine refuses it$/,
    );
    expect(formatRoutingView(view).join("\n")).toMatch(
      /\.vtc\/project\.yaml does not load \(concurrency: .*\), so its hosts\.models are not shown/,
    );
  });

  it("fails a project.yaml routing whose min_tier is above its max_tier", () => {
    const [routing] = checks(
      projectYaml("version: 1\nrouting:\n  min_tier: top\n  max_tier: low\n"),
    );
    expect(routing?.status).toBe("fail");
    expect(routing?.detail).toMatch(
      /^\.vtc\/project\.yaml routing: .*routing\.min_tier may not be above routing\.max_tier/,
    );
  });

  it("fails an invalid ~/.vtc/config.yaml lookback, and warns of a boosted cap below the base", () => {
    const bad = checks(
      DEFAULT_PROJECT,
      userYaml("version: 1\nlookback:\n  max_trials_per_retro: 0\n"),
    );
    expect(bad[2]?.status).toBe("fail");
    expect(bad[2]?.detail).toMatch(/^~\/\.vtc\/config\.yaml lookback: max_trials_per_retro: /);
    const low = checks(
      DEFAULT_PROJECT,
      userYaml(
        "version: 1\nlookback:\n  max_trials_per_retro: 30\n  max_trials_per_retro_boosted: 20\n",
      ),
    );
    expect(low[2]?.status).toBe("warn");
    expect(low[2]?.detail).toMatch(
      /lookback\.max_trials_per_retro_boosted \(20\) is below max_trials_per_retro \(30\), so the boost is off/,
    );
    // a file broken elsewhere still has its lookback section read on its own
    const elsewhere = checks(
      DEFAULT_PROJECT,
      userYaml("version: 1\nenv_passthrough: 7\nlookback:\n  replay_failure_tasks: 3\n"),
    );
    expect(elsewhere[2]?.status).toBe("ok");
    expect(elsewhere[2]?.detail).toMatch(/^3 recent failures/);
  });
});

describe("vtc doctor prints the routing checks (H-9)", () => {
  const quiet: Exec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

  const doctor = async (
    project: ProjectRoutingRead,
    user: UserConfigRead = DEFAULT_USER,
  ): Promise<{ code: number; text: string }> => {
    const { ctx, out } = capture("/w", "/h");
    const code = await createDoctorCommand(() => ({
      exec: quiet,
      versions: { node: "22.17.1" },
      userConfig: () => user,
      routing: {
        project: () => Promise.resolve(project),
        weekly: () =>
          Promise.resolve({
            source: "engine",
            hosts: [{ host: "claude-code", remaining_pct: 80 }],
          }),
      },
    })).run([], ctx);
    return { code, text: out.join("\n") };
  };

  it("adds routing, models and lookback lines, failing none of them by default", async () => {
    const { code, text } = await doctor(DEFAULT_PROJECT);
    expect(code).toBe(0);
    expect(text).toMatch(/^ok {4}routing {6}per-task roles start by task difficulty: S low/m);
    expect(text).toMatch(/^info {2}models {7}claude-code: low haiku, mid sonnet, top opus/m);
    expect(text).toMatch(/^ok {4}lookback {5}6 recent failures .*claude-code 80% left: 36/m);
  });

  it("fails doctor on an inverted project range or an invalid user lookback", async () => {
    const inverted = await doctor(
      projectYaml("version: 1\nrouting:\n  min_tier: top\n  max_tier: mid\n"),
    );
    expect(inverted.code).toBe(1);
    expect(inverted.text).toMatch(/^FAIL {2}routing {6}\.vtc\/project\.yaml routing: /m);
    const lookback = await doctor(
      DEFAULT_PROJECT,
      userYaml("version: 1\nlookback:\n  boost_above_weekly_pct: 120\n"),
    );
    expect(lookback.code).toBe(1);
    expect(lookback.text).toMatch(
      /^FAIL {2}lookback {5}~\/\.vtc\/config\.yaml lookback: boost_above_weekly_pct/m,
    );
  });
});
