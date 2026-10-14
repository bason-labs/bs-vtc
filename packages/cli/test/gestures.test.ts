/**
 * The human gestures that write files directly (spine §5 readings 103 and 104):
 * `vtc lookback approve|pin|rollback` (AD-21 rule 3: `pins.yaml`, `by: human`) and
 * `vtc merge-level restore` (AD-23 rule 5: a `restore` ledger entry). Both refuse without an
 * interactive terminal (the AD-21 Check's cli part) and write nothing on a no.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { core } from "@vtc/engine";
import {
  effectiveMergeLevel,
  engineRepoKey,
  LOOKBACK_HOME,
  LookbackPinsSchema,
  MERGE_LEVEL_LEDGER,
  MergeLevelLedgerEntrySchema,
  type LookbackPins,
  type MergeLevelLedgerEntry,
} from "@vtc/shared";
import { createLookbackCommand } from "../src/commands/lookback.js";
import { createMergeLevelCommand } from "../src/commands/merge-level.js";
import { EXIT_NOT_CONFIRMED, type GestureDeps } from "../src/human-gesture.js";
import { pinsPath } from "../src/lookback-pins.js";
import { capture, cleanupDirs, initRepo, initVtcRepo, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

const NOW = new Date("2026-10-14T10:00:00.000Z");

const human = (answer: boolean | "no-terminal"): GestureDeps & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    interactive: () => answer !== "no-terminal",
    confirm: (q) => {
      asked.push(q);
      return Promise.resolve(answer === true);
    },
    now: () => NOW,
  };
};

const sha = (c: string): string => c.repeat(64);

// ------------------------------------------------------------- merge level

const ledgerLine = (entry: Partial<MergeLevelLedgerEntry>): string =>
  JSON.stringify(
    MergeLevelLedgerEntrySchema.parse({
      v: 1,
      at: "2026-10-13T09:00:00.000Z",
      kind: "downgrade",
      cap: 2,
      reason: "revert",
      feature: "F-3",
      detail: "the merge of F-3 was reverted on main",
      ...entry,
    }),
  );

const levelRepo = (level: 1 | 2 | 3, ledger: string[]): string => {
  const repo = initVtcRepo();
  const path = join(repo, ".vtc/project.yaml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/^merge_level: \d$/m, `merge_level: ${String(level)}`),
  );
  expect(core.loadProjectConfig(repo).merge_level).toBe(level);
  if (ledger.length > 0) writeFileSync(join(repo, MERGE_LEVEL_LEDGER), `${ledger.join("\n")}\n`);
  return repo;
};

const ledgerOf = (repo: string): MergeLevelLedgerEntry[] =>
  readFileSync(join(repo, MERGE_LEVEL_LEDGER), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => MergeLevelLedgerEntrySchema.parse(JSON.parse(l)));

describe("vtc merge-level restore (AD-23 rule 5)", () => {
  it("refuses without an interactive terminal and leaves the ledger as it was", async () => {
    const repo = levelRepo(3, [ledgerLine({})]);
    const before = readFileSync(join(repo, MERGE_LEVEL_LEDGER), "utf8");
    const { ctx, out, err } = capture(repo, tempHome());
    const deps = human("no-terminal");
    expect(await createMergeLevelCommand(() => deps).run(["restore"], ctx)).toBe(
      EXIT_NOT_CONFIRMED,
    );
    expect(out.join("\n")).toMatch(/merge level is 2: project.yaml says 3, and .* caps it at 2/);
    expect(err.join("\n")).toMatch(/human decision: run it yourself in an interactive terminal/);
    expect(deps.asked).toEqual([]);
    expect(readFileSync(join(repo, MERGE_LEVEL_LEDGER), "utf8")).toBe(before);
  });

  it("writes nothing when the human says no", async () => {
    const repo = levelRepo(3, [ledgerLine({})]);
    const { ctx } = capture(repo, tempHome());
    expect(await createMergeLevelCommand(() => human(false)).run(["restore"], ctx)).toBe(
      EXIT_NOT_CONFIRMED,
    );
    expect(ledgerOf(repo)).toHaveLength(1);
  });

  it("appends a human restore after a yes, raising the effective level", async () => {
    const repo = levelRepo(3, [
      ledgerLine({}),
      ledgerLine({ cap: 1, reason: "post_merge_ci_failure" }),
    ]);
    const { ctx, out } = capture(repo, tempHome());
    const deps = human(true);
    expect(
      await createMergeLevelCommand(() => deps).run(
        ["restore", "--reason", "fixed the flaky CI"],
        ctx,
      ),
    ).toBe(0);
    expect(deps.asked).toEqual(["Restore the merge level to 3?"]);
    const entries = ledgerOf(repo);
    expect(entries.at(-1)).toEqual({
      v: 1,
      at: NOW.toISOString(),
      kind: "restore",
      cap: 3,
      reason: "human",
      detail: "fixed the flaky CI",
    });
    expect(effectiveMergeLevel(3, entries)).toBe(3);
    expect(out.at(-1)).toMatch(/the merge level is 3\. Commit the file/);
  });

  it("restores to a chosen cap, and says when there is nothing to restore", async () => {
    const repo = levelRepo(3, [ledgerLine({ cap: 1 })]);
    const { ctx } = capture(repo, tempHome());
    expect(
      await createMergeLevelCommand(() => human(true)).run(["restore", "--level", "2"], ctx),
    ).toBe(0);
    expect(effectiveMergeLevel(3, ledgerOf(repo))).toBe(2);
    const again = capture(repo, tempHome());
    expect(
      await createMergeLevelCommand(() => human(true)).run(["restore", "--level", "2"], again.ctx),
    ).toBe(0);
    expect(again.out.join("\n")).toMatch(/Nothing to restore/);
    expect(ledgerOf(repo)).toHaveLength(2);
    const clean = levelRepo(2, []);
    const c = capture(clean, tempHome());
    expect(await createMergeLevelCommand(() => human(true)).run(["restore"], c.ctx)).toBe(0);
    expect(c.out.join("\n")).toMatch(/Nothing to restore: the ledger caps the merge level at 3/);
    expect(existsSync(join(clean, MERGE_LEVEL_LEDGER))).toBe(false);
  });

  it("skips a ledger line that does not parse, and checks its arguments", async () => {
    const repo = levelRepo(3, ["{not json", ledgerLine({})]);
    const { ctx, err } = capture(repo, tempHome());
    expect(await createMergeLevelCommand(() => human(true)).run(["restore"], ctx)).toBe(0);
    expect(err.join("\n")).toMatch(/line 1 does not parse; skipped/);
    const bad = capture(repo, tempHome());
    expect(await createMergeLevelCommand(() => human(true)).run(["lower"], bad.ctx)).toBe(64);
    expect(
      await createMergeLevelCommand(() => human(true)).run(["restore", "--level", "4"], bad.ctx),
    ).toBe(64);
    const plain = capture(initRepo(), tempHome());
    expect(await createMergeLevelCommand(() => human(true)).run(["restore"], plain.ctx)).toBe(1);
    expect(plain.err.join("\n")).toMatch(/vtc init/);
  });
});

// ---------------------------------------------------------------- lookback

const ROLE = "engineer";
const HOST = "claude-code";

/** An immutable version file under the VTC home, as the engine writes it. */
const writeVersion = (
  home: string,
  effective: string,
  options: {
    parent?: string | null;
    evaluation?: string | null;
    role?: string;
    host?: string;
  } = {},
): void => {
  const role = options.role ?? ROLE;
  const host = options.host ?? HOST;
  const front = {
    v: 1,
    version: {
      role,
      host,
      locked_sha256: sha("1"),
      editable_sha256: sha("2"),
      effective_sha256: effective,
    },
    parent: options.parent ?? null,
    proposal: "p-1",
    changelog: {
      hypothesis: "say what to test first",
      trace_ids: [],
      evaluation: options.evaluation ?? null,
    },
    created_at: "2026-10-13T08:00:00.000Z",
  };
  const path = join(home, LOOKBACK_HOME.promptsDir, role, host, `${effective.slice(0, 8)}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${JSON.stringify(front, null, 2)}\n---\nTest first.\n`);
};

const writeReplay = (
  repo: string,
  candidate: string,
  verdict: string,
  baseline = sha("a"),
): string => {
  const rel = ".vtc/lookback/replays/p-1.json";
  mkdirSync(join(repo, dirname(rel)), { recursive: true });
  writeFileSync(
    join(repo, rel),
    JSON.stringify({
      v: 1,
      proposal: "p-1",
      role: ROLE,
      host: HOST,
      baseline,
      candidate,
      grader_bundle_sha: sha("9"),
      k: 3,
      per_task: [
        { task: "T-1", a: [false, false, false], b: [true, true, true], regression_set: false },
      ],
      aa_flip_rate: 0.05,
      sign_test: { n_discordant: 6, wins_b: 6, p: 0.016 },
      tokens_delta_pct: 4,
      verdict,
      finished_at: "2026-10-13T09:00:00.000Z",
    }),
  );
  return rel;
};

const pinsOf = (home: string): LookbackPins =>
  LookbackPinsSchema.parse(core.parseYaml(readFileSync(pinsPath(home), "utf8")));

const run = async (
  repo: string,
  home: string,
  args: string[],
  answer: boolean | "no-terminal" = true,
): Promise<{ code: number; out: string; err: string }> => {
  const { ctx, out, err } = capture(repo, home);
  const code = await createLookbackCommand(() => human(answer)).run(args, ctx);
  return { code, out: out.join("\n"), err: err.join("\n") };
};

const T = ["--role", ROLE, "--host", HOST];

describe("vtc lookback approve|pin|rollback (AD-21 rule 3)", () => {
  it("refuses without an interactive terminal and writes no pins", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    const r = await run(
      repo,
      home,
      ["pin", ...T, "--version", sha("a").slice(0, 8)],
      "no-terminal",
    );
    expect(r.code).toBe(EXIT_NOT_CONFIRMED);
    expect(r.out).toMatch(/Pin engineer on claude-code to aaaaaaaa/);
    expect(r.err).toMatch(/human decision/);
    expect(existsSync(pinsPath(home))).toBe(false);
    const no = await run(repo, home, ["pin", ...T, "--version", sha("a")], false);
    expect(no.code).toBe(EXIT_NOT_CONFIRMED);
    expect(existsSync(pinsPath(home))).toBe(false);
  });

  it("pins a version for this repo only, recording the gesture as a human's", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    const r = await run(repo, home, [
      "pin",
      ...T,
      "--version",
      "aaaaaaaa",
      "--reason",
      "known good",
    ]);
    expect(r.code, r.err).toBe(0);
    const key = engineRepoKey(repo);
    const pins = pinsOf(home);
    expect(pins.projects[key]?.pins).toEqual([
      { role: ROLE, host: HOST, effective_sha256: sha("a") },
    ]);
    expect(pins.history).toEqual([
      {
        role: ROLE,
        host: HOST,
        at: NOW.toISOString(),
        repo_key: key,
        gesture: "pin",
        from: null,
        to: sha("a"),
        by: "human",
        reason: "known good",
      },
    ]);
    // nothing inside the repo is written: a repo never selects a prompt
    expect(existsSync(join(repo, ".vtc/lookback"))).toBe(false);
  });

  it("starts a canary only on an improve replay, promotes it on a second approve", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    expect((await run(repo, home, ["pin", ...T, "--version", sha("a")])).code).toBe(0);
    // no replay result: no canary
    writeVersion(home, sha("b"), { parent: sha("a") });
    const none = await run(repo, home, ["approve", ...T, "--version", sha("b")]);
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/names no replay result.*vtc lookback pin/);
    // an inconclusive replay: no canary
    const home2 = tempHome();
    writeVersion(home2, sha("c"), {
      parent: sha("a"),
      evaluation: writeReplay(repo, sha("c"), "inconclusive"),
    });
    const inc = await run(repo, home2, ["approve", ...T, "--version", sha("c")]);
    expect(inc.code).toBe(1);
    expect(inc.err).toMatch(/says inconclusive, not improve/);
    // an improve replay of this very version: the canary starts against the current pin
    writeVersion(home, sha("d"), {
      parent: sha("a"),
      evaluation: writeReplay(repo, sha("d"), "improve"),
    });
    const start = await run(repo, home, ["approve", ...T, "--version", sha("d")]);
    expect(start.code, start.err).toBe(0);
    expect(start.out).toMatch(/Start a canary of dddddddd .* half run aaaaaaaa/);
    const key = engineRepoKey(repo);
    expect(pinsOf(home).projects[key]?.canaries).toEqual([
      {
        role: ROLE,
        host: HOST,
        candidate: sha("d"),
        baseline: sha("a"),
        started_at: NOW.toISOString(),
        assignment: "task_hash_50",
      },
    ]);
    // another version cannot start a second canary for the same prompt
    writeVersion(home, sha("e"), {
      parent: sha("a"),
      evaluation: writeReplay(repo, sha("e"), "improve"),
    });
    expect((await run(repo, home, ["approve", ...T, "--version", sha("e")])).err).toMatch(
      /a canary of dddddddd is running/,
    );
    // approving the candidate again promotes it
    const promote = await run(repo, home, ["approve", ...T, "--version", sha("d")]);
    expect(promote.code, promote.err).toBe(0);
    const after = pinsOf(home);
    expect(after.projects[key]).toEqual({
      pins: [{ role: ROLE, host: HOST, effective_sha256: sha("d") }],
      canaries: [],
    });
    expect(after.history.map((h) => [h.gesture, h.from, h.to, h.by])).toEqual([
      ["pin", null, sha("a"), "human"],
      ["approve", sha("a"), sha("d"), "human"],
      ["promote", sha("a"), sha("d"), "human"],
    ]);
  });

  it("rolls a canary back to its baseline, and a pin back to what it replaced", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    writeVersion(home, sha("b"));
    writeVersion(home, sha("d"), {
      parent: sha("b"),
      evaluation: writeReplay(repo, sha("d"), "improve"),
    });
    await run(repo, home, ["pin", ...T, "--version", sha("a")]);
    await run(repo, home, ["pin", ...T, "--version", sha("b")]);
    await run(repo, home, ["approve", ...T, "--version", sha("d")]);
    const key = engineRepoKey(repo);
    const canary = await run(repo, home, ["rollback", ...T]);
    expect(canary.code, canary.err).toBe(0);
    expect(canary.out).toMatch(/End the canary of dddddddd .* every task runs bbbbbbbb/);
    expect(pinsOf(home).projects[key]?.canaries).toEqual([]);
    expect((await run(repo, home, ["rollback", ...T])).out).toMatch(/from bbbbbbbb to aaaaaaaa/);
    expect(pinsOf(home).projects[key]?.pins).toEqual([
      { role: ROLE, host: HOST, effective_sha256: sha("a") },
    ]);
    expect((await run(repo, home, ["rollback", ...T])).out).toMatch(/to the compiled default/);
    expect(pinsOf(home).projects[key]?.pins).toEqual([]);
    const nothing = await run(repo, home, ["rollback", ...T]);
    expect(nothing.code).toBe(1);
    expect(nothing.err).toMatch(/nothing to roll back/);
    expect(pinsOf(home).history.every((h) => h.by === "human")).toBe(true);
  });

  it("keeps other repos' and other prompts' pins, and the engine's own history", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    const other = "0123456789abcdef";
    const existing = LookbackPinsSchema.parse({
      v: 1,
      projects: {
        [other]: { pins: [{ role: ROLE, host: HOST, effective_sha256: sha("f") }] },
        [engineRepoKey(repo)]: {
          pins: [{ role: "qa", host: "codex", effective_sha256: sha("e") }],
        },
      },
      history: [
        {
          role: ROLE,
          host: HOST,
          at: "2026-10-12T00:00:00.000Z",
          repo_key: other,
          gesture: "auto_rollback",
          from: sha("c"),
          to: sha("f"),
          by: "engine",
          reason: "tokens up 30%",
        },
      ],
    });
    mkdirSync(dirname(pinsPath(home)), { recursive: true });
    writeFileSync(pinsPath(home), core.toYaml(existing));
    writeVersion(home, sha("a"));
    expect((await run(repo, home, ["pin", ...T, "--version", sha("a")])).code).toBe(0);
    const pins = pinsOf(home);
    expect(pins.projects[other]).toEqual(existing.projects[other]);
    expect(pins.projects[engineRepoKey(repo)]?.pins).toHaveLength(2);
    expect(pins.history[0]).toEqual(existing.history[0]);
  });

  it("refuses an unknown version, a pins file it cannot read, a link, and bad arguments", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    expect((await run(repo, home, ["pin", ...T, "--version", "abcdef12"])).err).toMatch(
      /no version abcdef12 of engineer on claude-code .*there: aaaaaaaa/,
    );
    writeVersion(home, sha("b"), { role: "qa" });
    expect(
      (await run(repo, home, ["pin", "--role", "qa", "--host", "codex", "--version", sha("b")]))
        .err,
    ).toMatch(/no version/);
    mkdirSync(dirname(pinsPath(home)), { recursive: true });
    writeFileSync(pinsPath(home), "v: 2\n");
    const broken = await run(repo, home, ["pin", ...T, "--version", sha("a")]);
    expect(broken.code).toBe(1);
    expect(broken.err).toMatch(/does not parse.*nothing was changed/);
    expect(readFileSync(pinsPath(home), "utf8")).toBe("v: 2\n");
    const linked = tempHome();
    writeVersion(linked, sha("a"));
    mkdirSync(dirname(pinsPath(linked)), { recursive: true });
    writeFileSync(join(linked, "elsewhere.yaml"), "v: 1\n");
    symlinkSync(join(linked, "elsewhere.yaml"), pinsPath(linked));
    expect((await run(repo, linked, ["pin", ...T, "--version", sha("a")])).err).toMatch(
      /symbolic link/,
    );
    expect((await run(repo, home, ["pin", ...T])).code).toBe(64);
    expect((await run(repo, home, ["rollback", ...T, "--version", sha("a")])).code).toBe(64);
    expect((await run(repo, home, ["promote", ...T])).code).toBe(64);
    expect(
      (await run(repo, home, ["pin", "--role", "Engineer", "--host", HOST, "--version", sha("a")]))
        .code,
    ).toBe(64);
    const plain = await run(initRepo(), home, ["rollback", ...T]);
    expect(plain.code).toBe(1);
    expect(plain.err).toMatch(/vtc init/);
  });
});
