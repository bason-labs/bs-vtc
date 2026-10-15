/**
 * Budget-checked Codex runs (§11, H-1; spine §5 reading 152): Codex reports tokens but no cost,
 * so the engine prices a run's tokens from the user's price table (`~/.vtc/config.yaml`
 * `prices`). An engine-launched run on a host that cannot cap its own spend starts only when its
 * model is priced there: a model missing from the price table is an error, never $0.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostOutcome, LeadAction, RoleResultInput } from "@vtc/shared";
import type { CallContext } from "../../src/core/index.js";
import { writeFile } from "../helpers/repo.js";
import {
  createHarness,
  spawns,
  type Harness,
  type HeadlessScript,
} from "../helpers/engine-harness.js";

const CODEX: CallContext = { host: "codex" };

interface Line {
  type: string;
  role?: string;
  model?: string;
  cost_usd?: number | null;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const ofType = (h: Harness, type: string): Line[] => events(h).filter((e) => e.type === type);

const start = (h: Harness) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CODEX,
  );
const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CODEX)).actions;

/** What Codex reports: tokens (cached input apart), no model, no cost. */
const codexDone = (output: Partial<RoleResultInput>): HostOutcome => ({
  kind: "done",
  session_ref: null,
  output: { summary: "done", ...output },
  model: null,
  tokens: { in: 200_000, out: 10_000, cache_r: 100_000, cache_w: 0 },
  cost_usd: null,
});

const cartographer: HeadlessScript = (request) => {
  writeFile(request.cwd, ".vtc/research/repo-map/map.md", "# map\n");
  return codexDone({
    role: "repo_cartographer",
    exit: "done",
    artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
  });
};

const signedIn = () =>
  Promise.resolve({
    host: "codex" as const,
    logged_in: true,
    method: "ChatGPT",
    checked_at: "2026-10-13T09:00:00.000Z",
  });

/** A Codex host as the real adapter is: no `--max-budget-usd`, no reported cost. */
const codexHost = {
  headless: cartographer,
  authStatus: signedIn,
  capabilities: { budgetCap: false },
};

const MODELS = { codex: { top: "gpt-test", mid: "gpt-test", low: "gpt-test" } };
const PRICE = { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 10 };

describe(
  "§11, H-1: an engine-launched Codex run is priced from the price table",
  { timeout: 30_000 },
  () => {
    it("prices the tokens Codex reported and counts the spend", async () => {
      const h = createHarness({
        project: { hosts: { models: MODELS } },
        codex: codexHost,
        prices: { "gpt-test": PRICE },
      });
      await start(h);
      expect(spawns(await next(h))).toEqual([]);
      await h.engine.settle();
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ host: "codex", ok: true });
      // 200k fresh input × $1 + 100k cached × $0.10 + 10k output × $10, per million tokens
      const submitted = ofType(h, "role.submitted").find((e) => e.role === "repo_cartographer");
      expect(submitted?.model).toBe("gpt-test");
      expect(submitted?.cost_usd).toBe(0.31);
      await h.release();
    });

    it("an unpriced model never starts: the preflight fails on budget and names the price table", async () => {
      const h = createHarness({
        project: { hosts: { models: MODELS } },
        codex: codexHost,
        prices: { "gpt-other": PRICE },
      });
      await start(h);
      await next(h);
      expect(h.launched).toEqual([]);
      const preflight = ofType(h, "headless.preflight")[0]?.data;
      expect(preflight).toMatchObject({ host: "codex", ok: false, failed: "budget" });
      expect(preflight?.detail).toMatch(/gpt-test.*prices/);
      // a task-less step: the run pauses until the human prices the model and resumes
      expect(h.engine.status({}).run.paused).toBe(true);
      await h.release();
    });

    it("prices a phase role on the tier it is dispatched on: its own tier clamped by routing.max_tier (D-cm)", async () => {
      // the cartographer's own tier is mid; max_tier low dispatches it on low, which alone is priced
      const h = createHarness({
        project: {
          hosts: { models: { codex: { top: "gpt-top", mid: "gpt-mid", low: "gpt-low" } } },
          routing: { max_tier: "low" },
        },
        codex: codexHost,
        prices: { "gpt-low": PRICE },
      });
      await start(h);
      await next(h);
      await h.engine.settle();
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ host: "codex", ok: true });
      const dispatched = ofType(h, "role.dispatched").find((e) => e.role === "repo_cartographer");
      expect(dispatched?.model).toBe("gpt-low");
      expect(dispatched?.data).toMatchObject({
        tier: "low",
        tier_reason: "role",
        tier_clamped: true,
      });
      await h.release();
    });

    it("a Codex role with no model id (the session's model) cannot be priced either", async () => {
      const h = createHarness({ codex: codexHost, prices: { "gpt-test": PRICE } });
      await start(h);
      await next(h);
      expect(h.launched).toEqual([]);
      const preflight = ofType(h, "headless.preflight")[0]?.data;
      expect(preflight).toMatchObject({ ok: false, failed: "budget" });
      expect(preflight?.detail).toContain("hosts.models.codex");
      await h.release();
    });

    it("a host that caps and reports its own spend needs no price", async () => {
      const h = createHarness({
        codex: { headless: cartographer, authStatus: signedIn },
      });
      await start(h);
      await next(h);
      await h.engine.settle();
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ ok: true });
      // no cost reported and no price: the run is flagged unpriced (null), never $0
      expect(ofType(h, "role.submitted")[0]?.cost_usd).toBeNull();
      await h.release();
    });
  },
);
