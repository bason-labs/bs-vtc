/**
 * The owner's first run (v0.1.0, a Codex Lead, a quick_fix; spine §5 readings 258–263), with
 * synthetic data only:
 * - a-1: the BA returned a task id on a task-less dispatch, a-2: an artifact type its contract
 *   does not declare. A headless run now gets its dispatch's own schema and the compiled locked
 *   part (contract and result protocol), and the prompt names the fields (readings 258, 259);
 * - the BA's context: the prompt says how much to read, and packs list gate commands only for
 *   roles that run code (reading 261);
 * - the request's pasted images: `start` and `change_request` take attachments (reading 262);
 * - `usage.updated` every two minutes for hours while the run was paused (reading 263).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sha256Hex,
  type HostOutcome,
  type LeadAction,
  type RoleResultInput,
  type UsageSnapshot,
} from "@vtc/shared";
import { resultFields } from "../../src/core/dispatch.js";
import { createPluginCatalog, type CallContext, type PluginCatalog } from "../../src/core/index.js";
import { USAGE_IDLE_LOG_MS } from "../../src/core/engine.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import { CLAUDE, createHarness, only, type Harness } from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const CODEX: CallContext = { host: "codex" };

interface Line {
  type: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const ofType = (h: Harness, type: string): Line[] => events(h).filter((e) => e.type === type);

const quickFix = (h: Harness, call: CallContext, attachments?: string[]) =>
  h.engine.start(
    {
      request: "Show the order total on checkout [Image #1]",
      track: "quick_fix",
      repo: "existing",
      has_ui: true,
      risk_hints: [],
      ...(attachments === undefined ? {} : { attachments }),
    },
    call,
  );
const next = async (h: Harness, call: CallContext): Promise<LeadAction[]> =>
  (await h.engine.next({}, call)).actions;

const done = (output: Partial<RoleResultInput>): HostOutcome => ({
  kind: "done",
  session_ref: null,
  output: { summary: "done", ...output },
  model: "gpt-6.1-sol",
  tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 },
  cost_usd: 0.1,
});

const ba = (request: { cwd: string }): HostOutcome => {
  writeFile(
    request.cwd,
    ".vtc/spec/spec.md",
    "# Spec\n\n## REQ-1 Order total\n\n- REQ-1.AC-1: x\n",
  );
  return done({
    role: "ba",
    exit: "done",
    artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
  });
};

const signedIn = () =>
  Promise.resolve({
    host: "codex" as const,
    logged_in: true,
    method: null,
    checked_at: "2026-10-13T09:00:00.000Z",
  });

type Props = Record<string, Record<string, unknown>>;
const props = (schema: Readonly<Record<string, unknown>>): Props => schema.properties as Props;

/** 1×1 PNG. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c00000000049454e44ae426082",
  "hex",
);

describe("a headless BA on a task-less dispatch (readings 258, 259)", { timeout: 30_000 }, () => {
  it("gets the dispatch's own schema: no task, mode or feature, only its artifact types", async () => {
    const h = createHarness({ codex: { headless: ba, authStatus: signedIn } });
    await quickFix(h, CODEX);
    await next(h, CODEX);
    const { request } = h.launched[0]!;
    expect(request.role).toBe("ba");
    const schema = props(request.outputSchema);
    expect(schema.role).toEqual({ type: "string", enum: ["ba"] });
    expect(schema.task).toEqual({ type: "null" });
    expect(schema.mode).toEqual({ type: "null" });
    expect(schema.feature).toEqual({ type: "null" });
    expect(JSON.stringify(schema.artifacts)).toContain('"enum":["spec"]');
    expect(schema.exit).toEqual({ type: "string", enum: ["done", "blocked", "spec_conflict"] });
    // the prompt says the same, for a host that does not honour the schema
    expect(request.prompt).toContain(
      'role "ba"; mode, task, feature null (this dispatch has no mode or task or feature; never take one from the repository); artifacts of type "spec" only; exit "done", "blocked", "spec_conflict"',
    );
    await h.engine.settle();
    expect(ofType(h, "role.submitted")).toHaveLength(1);
    await h.release();
  });

  it("names the task and its feature on a task dispatch, and a reviewer's subject", () => {
    expect(
      resultFields({ role: "engineer", task: "T-3" }, "F-1", {
        id: "engineer",
        mode: undefined,
        inputs: [],
        output: { artifacts: [], verdicts: [] },
        exits: ["built", "blocked"],
        tools: { profile: "code_sandboxed", write_paths: [], engine_tools: [] },
        models: {
          "claude-code": { tier: "mid", effort: "medium" },
          codex: { tier: "mid", effort: "medium" },
        },
      }),
    ).toBe(
      'role "engineer"; task "T-3"; feature "F-1"; mode null (this dispatch has no mode; never take one from the repository); no artifacts; exit "built", "blocked"',
    );
    expect(
      resultFields({ role: "spec_verifier", task: "T-3", subject: "REQ-1.AC-1" }, "F-1", undefined),
    ).toBe(
      'role "spec_verifier"; task "T-3"; feature "F-1"; verdict subject "REQ-1.AC-1"; mode null (this dispatch has no mode; never take one from the repository)',
    );
  });

  it("carries the compiled locked part when the plugin ships it, else the locked core", async () => {
    const LOCKED = "You are the BA.";
    const HEADLESS = `${LOCKED}\n\n## Contract\n\nOutput artifacts: spec.\n\n## Working and returning your result\n\nCopy the Dispatch lines.`;
    const plugins = (headless: string | undefined): PluginCatalog => ({
      ...createPluginCatalog({}),
      promptParts: () => ({
        lockedSha256: sha256Hex(LOCKED),
        editableInPack: false,
        compiled: {
          locked: LOCKED,
          editable: "Prefer short specs.",
          ...(headless === undefined ? {} : { headless }),
        },
      }),
    });
    for (const [headless, starts] of [
      [HEADLESS, `${HEADLESS}\n\n---\n\nVTC dispatch`],
      [undefined, `${LOCKED}\n\n---\n\nVTC dispatch`],
    ] as const) {
      const h = createHarness({
        plugins: plugins(headless),
        codex: { headless: ba, authStatus: signedIn },
      });
      await quickFix(h, CODEX);
      await next(h, CODEX);
      expect(h.launched[0]?.request.prompt.startsWith(starts)).toBe(true);
      await h.engine.settle();
      await h.release();
    }
  });
});

describe("what a BA reads (reading 261)", { timeout: 30_000 }, () => {
  it("is told its budget, that the pack lists every input, and that a quick fix's spec is short", async () => {
    const h = createHarness({ codex: { headless: ba, authStatus: signedIn } });
    await quickFix(h, CODEX);
    await next(h, CODEX);
    const { prompt } = h.launched[0]!.request;
    expect(prompt).toMatch(/Reading: keep your context under \d+k tokens\./);
    expect(prompt).toContain("Your pack lists every input there is");
    expect(prompt).toContain("This is a quick fix: write a short specification");
    await h.engine.settle();
    await h.release();
  });

  it("lists no gate commands in a task-less step's pack", async () => {
    const h = createHarness();
    await quickFix(h, CLAUDE);
    const spawn = only(await next(h, CLAUDE), "ba");
    const pack = readFileSync(join(h.repo, spawn.pack), "utf8");
    expect(pack).toContain("## Gate commands\n\n(none)\n");
    await h.release();
  });
});

describe("image attachments (reading 262)", { timeout: 30_000 }, () => {
  it("copies the images into the run and lists them in the BA's pack", async () => {
    const dir = tempDir("vtc-attach-");
    const shot = join(dir, "Screenshot 2026-10-16 at 12.20.01.png");
    writeFileSync(shot, PNG);
    const h = createHarness();
    await quickFix(h, CLAUDE, [shot]);
    const run = h.engine.status({}).run.id;
    const copy = `.vtc/runs/${run}/attachments/1-Screenshot-2026-10-16-at-12.20.01.png`;
    expect(ofType(h, "run.started")[0]?.data.attachments).toEqual([copy]);
    expect(readFileSync(join(h.repo, copy))).toEqual(PNG);
    const spawn = only(await next(h, CLAUDE), "ba");
    const pack = readFileSync(join(h.repo, spawn.pack), "utf8");
    expect(pack).toContain(`- attachments: ${copy}`);
    // the BA's own worktree has the copy too
    const cwd = /Work in: (.+)/.exec(spawn.prompt)?.[1] ?? "";
    expect(cwd).not.toBe("");
    expect(existsSync(join(cwd, copy))).toBe(true);
    await h.release();
  });

  it("refuses anything but an image file before the run starts", async () => {
    const dir = tempDir("vtc-attach-");
    const notes = join(dir, "notes.png");
    writeFileSync(notes, "not an image");
    const key = join(dir, "id_ed25519");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----");
    const h = createHarness();
    for (const [paths, why] of [
      [[notes], /is not an image/],
      [[key], /is not an image file/],
      [[join(dir, "missing.png")], /cannot be read/],
    ] as const) {
      await expect(quickFix(h, CLAUDE, [...paths])).rejects.toThrow(why);
    }
    expect(existsSync(join(h.repo, ".vtc/runs"))).toBe(false);
    await h.release();
  });
});

const codexUsage = (pct: number, resetsAt: string): UsageSnapshot => ({
  host: "codex",
  source: "app_server",
  windows: [
    {
      kind: "five_hour",
      label: "five_hour",
      window_minutes: 300,
      used_pct: pct,
      resets_at: resetsAt,
    },
  ],
  model_limits: [],
  updated_at: null,
});

describe("usage.updated (reading 263)", { timeout: 30_000 }, () => {
  it("ignores a reset a second off and an unstarted window's sliding reset", async () => {
    const h = createHarness();
    await quickFix(h, CLAUDE);
    h.engine.ingestUsage(codexUsage(40, "2026-10-13T12:38:32.000Z"));
    h.engine.ingestUsage(codexUsage(40, "2026-10-13T12:38:33.000Z"));
    h.engine.ingestUsage(codexUsage(40, "2026-10-13T12:38:32.000Z"));
    h.engine.ingestUsage(codexUsage(0, "2026-10-13T14:00:00.000Z"));
    h.advance(2 * 60_000);
    h.engine.ingestUsage(codexUsage(0, "2026-10-13T14:02:00.000Z"));
    h.advance(2 * 60_000);
    h.engine.ingestUsage(codexUsage(0, "2026-10-13T14:04:00.000Z"));
    h.engine.ingestUsage(codexUsage(3, "2026-10-13T14:04:00.000Z"));
    await h.engine.settle();
    expect(
      ofType(h, "usage.updated").map(
        (e) => (e.data.snapshot as UsageSnapshot).windows[0]?.used_pct,
      ),
    ).toEqual([40, 0, 3]);
    await h.release();
  });

  it("logs at most hourly while the run is paused, unless a window fills", async () => {
    const h = createHarness();
    await quickFix(h, CLAUDE);
    await h.engine.pause({});
    const reset = "2026-10-13T13:00:00.000Z";
    for (let pct = 10; pct <= 60; pct += 2) {
      h.engine.ingestUsage(codexUsage(pct, reset));
      h.advance(2 * 60_000);
    }
    // 26 readings over 52 minutes: the first only
    await h.engine.settle();
    expect(ofType(h, "usage.updated")).toHaveLength(1);
    h.advance(USAGE_IDLE_LOG_MS);
    h.engine.ingestUsage(codexUsage(70, reset));
    h.engine.ingestUsage(codexUsage(100, reset));
    h.engine.ingestUsage(codexUsage(100, reset));
    await h.engine.settle();
    expect(
      ofType(h, "usage.updated").map(
        (e) => (e.data.snapshot as UsageSnapshot).windows[0]?.used_pct,
      ),
    ).toEqual([10, 70, 100]);
    await h.release();
  });
});
