/**
 * `vtc config [--json]` (H-9 routing visibility): show-only, the effective routing of the repo it
 * runs in (`routing-view.ts`), with the weekly window read from the repo's running engine only
 * (never started for it). Exit 1 when `project.yaml` `routing` or `~/.vtc/config.yaml`
 * `lookback` is invalid.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_HTTP } from "@vtc/shared";
import {
  createConfigCommand,
  readWeeklyWindows,
  type ConfigCommandEnv,
} from "../src/commands/config.js";
import type { ProjectRoutingRead } from "../src/routing-view.js";
import type { UserConfigRead } from "../src/user-config.js";
import { capture, cleanupDirs } from "./helpers.js";

afterEach(cleanupDirs);

const USER: UserConfigRead = {
  ok: true,
  path: "/h/config.yaml",
  config: { version: 1, env_passthrough: [] },
};
const PROJECT: ProjectRoutingRead = {
  kind: "read",
  routing: undefined,
  routingError: null,
  models: undefined,
  configError: null,
};

const env =
  (overrides: Partial<ConfigCommandEnv> = {}) =>
  (): ConfigCommandEnv => ({
    userConfig: () => USER,
    project: () => Promise.resolve(PROJECT),
    weekly: () => Promise.resolve({ source: "no_engine", hosts: [] }),
    ...overrides,
  });

describe("vtc config", () => {
  it("prints the routing table, the project's range, the models and the Lookback pace", async () => {
    const { ctx, out } = capture("/w", "/h");
    expect(await createConfigCommand(env()).run([], ctx)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/^Routing \(H-9\)/);
    expect(text).toMatch(/table v1: S low, M mid, L top/);
    expect(text).toMatch(/start tier by task size and risk, tiers low\.\.top/);
    expect(text).toMatch(/claude-code: low haiku, mid sonnet, top opus/);
    expect(text).toMatch(/codex: low gpt-6-luna, mid gpt-6\.1-sol, top gpt-6-astra/);
    expect(text).toMatch(/24 trials per RETRO, 36 while/);
  });

  it("--json prints the view as JSON, with control characters escaped", async () => {
    const { ctx, out } = capture("/w", "/h");
    const code = await createConfigCommand(
      env({
        project: () =>
          Promise.resolve({ ...PROJECT, models: { "claude-code": { top: "op\u009bus" } } }),
        weekly: () =>
          Promise.resolve({
            source: "engine",
            hosts: [{ host: "claude-code", remaining_pct: 40 }],
          }),
      }),
    ).run(["--json"], ctx);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/\u009b/);
    const view = JSON.parse(out[0] ?? "") as {
      start_tiers: unknown;
      models: { "claude-code": { top: { model: string } } };
      lookback: { weekly: { hosts: { max_trials_per_retro: number }[] } };
    };
    expect(view.models["claude-code"].top.model).toBe("op\u009bus");
    expect(view.start_tiers).not.toBeNull();
    expect(view.lookback.weekly.hosts[0]?.max_trials_per_retro).toBe(24);
  });

  it("exits 1 when project.yaml routing or the user's lookback is invalid, still showing the rest", async () => {
    const { ctx, out } = capture("/w", "/h");
    const code = await createConfigCommand(
      env({
        project: () =>
          Promise.resolve({
            ...PROJECT,
            routingError: "min_tier: routing.min_tier may not be above routing.max_tier",
          }),
      }),
    ).run([], ctx);
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/\.vtc\/project\.yaml routing is invalid: min_tier/);
    expect(out.join("\n")).toMatch(/Models per tier/);
    const bad: UserConfigRead = {
      ok: false,
      path: "/h/config.yaml",
      error: "lookback.max_trials_per_retro: too small",
      raw: { version: 1, lookback: { max_trials_per_retro: 0 } },
    };
    const second = capture("/w", "/h");
    expect(await createConfigCommand(env({ userConfig: () => bad })).run([], second.ctx)).toBe(1);
    expect(second.out.join("\n")).toMatch(/invalid: max_trials_per_retro: /);
  });

  it("exits 1 when project.yaml does not load", async () => {
    const { ctx } = capture("/w", "/h");
    const code = await createConfigCommand(
      env({ project: () => Promise.resolve({ ...PROJECT, configError: "concurrency: too big" }) }),
    ).run([], ctx);
    expect(code).toBe(1);
  });

  it("refuses arguments it does not know", async () => {
    const { ctx, err } = capture("/w", "/h");
    expect(await createConfigCommand(env()).run(["set", "x"], ctx)).toBe(64);
    expect(await createConfigCommand(env()).run(["--edit"], ctx)).toBe(64);
    expect(err.join("\n")).toMatch(/usage: vtc config \[--json\]/);
  });
});

describe("the weekly window for the Lookback pace", () => {
  const usage = (hosts: unknown[]) => ({
    status: 200,
    body: JSON.stringify({ hosts, interrupted_tasks: [], auto_resume_at: null }),
  });
  const window = (kind: string, used: number | null) => ({
    kind,
    label: kind,
    window_minutes: kind === "weekly" ? 10080 : 300,
    used_pct: used,
    resets_at: null,
  });

  it("reads each host's weekly window from the running engine only, never starting one", async () => {
    const asked: string[] = [];
    const weekly = await readWeeklyWindows("/h", "/r", {
      live: () => Promise.resolve({ port: 4100 } as never),
      token: () => "t",
      get: (port, path, token) => {
        asked.push(`${String(port)} ${path} ${token}`);
        return Promise.resolve(
          usage([
            {
              host: "claude-code",
              source: "statusline",
              windows: [window("five_hour", 90), window("weekly", 28)],
              model_limits: [],
              updated_at: null,
            },
            { host: "codex", source: "none", windows: [], model_limits: [], updated_at: null },
          ]),
        );
      },
    });
    expect(asked).toEqual([`4100 ${ENGINE_HTTP.routes.usage.path} t`]);
    expect(weekly).toEqual({
      source: "engine",
      hosts: [
        { host: "claude-code", remaining_pct: 72 },
        { host: "codex", remaining_pct: null },
      ],
    });
  });

  it("is unknown without a repo, a running engine, or an answer that parses", async () => {
    const never = () => Promise.reject(new Error("must not be asked"));
    expect(
      await readWeeklyWindows("/h", null, { live: never, token: () => "t", get: never }),
    ).toEqual({ source: "no_engine", hosts: [] });
    expect(
      await readWeeklyWindows("/h", "/r", {
        live: () => Promise.resolve(null),
        token: () => "t",
        get: never,
      }),
    ).toEqual({ source: "no_engine", hosts: [] });
    expect(
      await readWeeklyWindows("/h", "/r", {
        live: () => Promise.resolve({ port: 1 } as never),
        token: () => "t",
        get: () => Promise.resolve({ status: 200, body: "{nope" }),
      }),
    ).toEqual({ source: "engine", hosts: [] });
  });
});
