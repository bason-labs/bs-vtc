/**
 * The human gestures that write files directly (spine §5 readings 103 and 104):
 * `vtc lookback approve|pin|rollback` (AD-21 rule 3: `pins.yaml`, `by: human`) and
 * `vtc merge-level restore` (AD-23 rule 5: a `restore` ledger entry). Both refuse without an
 * interactive terminal (the AD-21 Check's cli part) and write nothing on a no.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { core } from "@vtc/engine";
import {
  effectiveMergeLevel,
  effectivePromptSha,
  engineRepoKey,
  eventLogPath,
  LOOKBACK_HOME,
  LookbackPinsSchema,
  MERGE_LEVEL_LEDGER,
  MergeLevelLedgerEntrySchema,
  sha256Hex,
  toEventLine,
  type LookbackPins,
  type MergeLevelLedgerEntry,
} from "@vtc/shared";
import {
  changesFilesOf,
  createLookbackCommand,
  editableInPackOf,
  type ChangesFilesOf,
  type EditableInPackOf,
  type LockedCoreOf,
} from "../src/commands/lookback.js";
import { createMergeLevelCommand } from "../src/commands/merge-level.js";
import { EXIT_NOT_CONFIRMED, type GestureDeps } from "../src/human-gesture.js";
import { pinsPath, readVersionFile, withPinsLock, writePins } from "../src/lookback-pins.js";
import { createDiskAssetBundle } from "../src/assets.js";
import {
  capture,
  cleanupDirs,
  initRepo,
  initVtcRepo,
  tempDir,
  tempHome,
  writePluginTrees,
} from "./helpers.js";

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

  it("refuses when the engine appends a downgrade while the human decides", async () => {
    const repo = levelRepo(3, [ledgerLine({})]);
    const { ctx, err } = capture(repo, tempHome());
    const fresh = ledgerLine({ cap: 1, reason: "revert", detail: "a new revert on main" });
    const deps: GestureDeps = {
      ...human(true),
      confirm: () => {
        // the engine's append, between what the human saw and their yes
        appendFileSync(join(repo, MERGE_LEVEL_LEDGER), `${fresh}\n`);
        return Promise.resolve(true);
      },
    };
    expect(await createMergeLevelCommand(() => deps).run(["restore"], ctx)).toBe(1);
    expect(err.join("\n")).toMatch(/changed while you decided; run it again/);
    const entries = ledgerOf(repo);
    expect(entries.map((e) => e.kind)).toEqual(["downgrade", "downgrade"]);
    expect(effectiveMergeLevel(3, entries)).toBe(1);
  });

  it("never reads the ledger through a symlink, and escapes control characters it shows", async () => {
    const repo = levelRepo(3, [
      ledgerLine({ detail: "reverted\u001b[2K\u001b[1Gall clear\u009b" }),
    ]);
    const shown = capture(repo, tempHome());
    expect(await createMergeLevelCommand(() => human(false)).run(["restore"], shown.ctx)).toBe(
      EXIT_NOT_CONFIRMED,
    );
    const text = shown.out.join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u009b");
    expect(text).toContain("reverted\\u001b[2K\\u001b[1Gall clear\\u009b");
    // a planted link to another ledger is refused, not followed
    const outside = tempHome();
    writeFileSync(join(outside, "ledger.jsonl"), `${ledgerLine({ cap: 1 })}\n`);
    rmSync(join(repo, MERGE_LEVEL_LEDGER));
    symlinkSync(join(outside, "ledger.jsonl"), join(repo, MERGE_LEVEL_LEDGER));
    const linked = capture(repo, tempHome());
    expect(await createMergeLevelCommand(() => human(true)).run(["restore"], linked.ctx)).toBe(1);
    expect(linked.err.join("\n")).toMatch(/symlink/);
    expect(
      readFileSync(join(outside, "ledger.jsonl"), "utf8").split("\n").filter(Boolean),
    ).toHaveLength(1);
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

const EDITABLE = "Test first.";

/**
 * An immutable version file under the VTC home, as the engine writes it. Its editable section
 * hashes to its `editable_sha256`; its effective SHA is a readable stand-in, so these versions are
 * checked against no locked core (the bundled plugin carries none here, `noLockedCore`).
 */
const writeVersion = (
  home: string,
  effective: string,
  options: {
    parent?: string | null;
    evaluation?: string | null;
    role?: string;
    host?: string;
    locked?: string;
    editable?: string;
  } = {},
): void => {
  const role = options.role ?? ROLE;
  const host = options.host ?? HOST;
  const front = {
    v: 1,
    version: {
      role,
      host,
      locked_sha256: options.locked === undefined ? sha("1") : sha256Hex(options.locked),
      editable_sha256: sha256Hex(EDITABLE),
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
  writeFileSync(
    path,
    `---\n${JSON.stringify(front, null, 2)}\n---\n${options.editable ?? EDITABLE}\n`,
  );
};

/**
 * A run log of `role.dispatched` events in each canary arm after the canary started (`NOW`):
 * `LOOKBACK_LIMITS` makes 10 candidate and 5 baseline dispatches with no trigger promotable.
 * With `tokens`, each dispatch is followed by a `role.submitted` that spent that many per arm.
 */
const writeCanaryLog = (
  repo: string,
  arms: { candidate: number; baseline: number },
  tokens?: { candidate: number; baseline: number },
): void => {
  const run = "r-canary";
  let seq = 0;
  const lines: string[] = [];
  const envelope = () => {
    seq += 1;
    return {
      v: 1 as const,
      seq,
      ts: new Date(NOW.getTime() + seq * 60_000).toISOString(),
      run,
      actor: "engine" as const,
      role: ROLE,
      host: HOST as "claude-code",
      model: "claude-sonnet-5",
      prompt_sha: sha("d"),
    };
  };
  for (const arm of ["candidate", "baseline"] as const)
    for (let i = 0; i < arms[arm]; i += 1) {
      const dispatched = envelope();
      const action = `a-${String(dispatched.seq)}`;
      lines.push(
        toEventLine({
          ...dispatched,
          type: "role.dispatched",
          data: {
            action_id: action,
            dispatch: "subagent",
            agent: "vtc-engineer",
            pack: `.vtc/state/packs/${action}.md`,
            resume: null,
            canary_arm: arm,
          },
        }),
      );
      if (tokens !== undefined)
        lines.push(
          toEventLine({
            ...envelope(),
            type: "role.submitted",
            tokens: { in: tokens[arm], out: 0, cache_r: 0, cache_w: 0 },
            cost_usd: 0,
            data: { action_id: action, exit: "done", findings: 0, questions: 0, session_ref: null },
          }),
        );
    }
  const path = join(repo, eventLogPath(run));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join(""));
};

/** A run log holding the engine's `lookback.replay_finished` for a replay file. */
const writeReplayFinished = (repo: string, rel: string, sha256?: string): void => {
  const run = "r-replay";
  const path = join(repo, eventLogPath(run));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    toEventLine({
      v: 1,
      seq: 1,
      ts: "2026-10-13T09:00:00.000Z",
      run,
      actor: "engine",
      type: "lookback.replay_finished",
      data: {
        proposal: "p-1",
        verdict: "improve",
        path: rel,
        ...(sha256 === undefined ? {} : { sha256 }),
      },
    }),
  );
};

const noLockedCore: LockedCoreOf = () => undefined;

/** `wins` tasks the candidate won outright, 3 runs per arm; the sign test is P(X >= wins) = 0.5^wins. */
const wonTasks = (wins: number) =>
  Array.from({ length: wins }, (_, i) => ({
    task: `T-${String(i + 1)}`,
    a: [false, false, false],
    b: [true, true, true],
    regression_set: false,
  }));

/** Consistent replay files: `improve` is 6 of 6 tasks won (p = 1/64), `inconclusive` 2 of 2 (p = 1/4). */
const REPLAYS = {
  improve: { per_task: wonTasks(6), sign_test: { n_discordant: 6, wins_b: 6, p: 1 / 64 } },
  inconclusive: { per_task: wonTasks(2), sign_test: { n_discordant: 2, wins_b: 2, p: 1 / 4 } },
} as const;

const writeReplay = (
  repo: string,
  candidate: string,
  verdict: keyof typeof REPLAYS,
  baseline = sha("a"),
  override: Record<string, unknown> = {},
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
      ...REPLAYS[verdict],
      aa_flip_rate: 0.05,
      tokens_delta_pct: 4,
      verdict,
      finished_at: "2026-10-13T09:00:00.000Z",
      ...override,
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
  lockedCore: LockedCoreOf = noLockedCore,
  whileDeciding?: () => void,
  editableInPack: EditableInPackOf = () => true,
  changesFiles: ChangesFilesOf = () => true,
): Promise<{ code: number; out: string; err: string }> => {
  const { ctx, out, err } = capture(repo, home);
  const deps = (): GestureDeps => {
    const h = human(answer);
    return whileDeciding === undefined
      ? h
      : {
          ...h,
          confirm: (q) => {
            whileDeciding();
            return h.confirm(q);
          },
        };
  };
  const code = await createLookbackCommand(deps, lockedCore, editableInPack, changesFiles).run(
    args,
    ctx,
  );
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
    // the human sees the evidence, and where it comes from (a repo file roles can write)
    expect(start.out).toMatch(
      /evidence \(\.vtc\/lookback\/replays\/p-1\.json, a file in the repo: check it\): its trials, recomputed here, say improve with p = 0\.016 over 6 discordant tasks \(6 won by the candidate\), 6 tasks x 3 runs per arm, tokens \+4%, A\/A flip rate 0\.05; no lookback\.replay_finished event in the repo's logs records its hash, so it was not checked against the engine's file\./,
    );
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
    // approving the candidate again before its window passed promotes nothing: no data yet
    const early = await run(repo, home, ["approve", ...T, "--version", sha("d")]);
    expect(early.code).toBe(1);
    expect(early.err).toMatch(
      /canary of dddddddd for engineer on claude-code is not promotable yet: no_data \(fewer than 5 dispatches in an arm\); candidate 0 dispatches.*Let it run, or pin a version outright with vtc lookback pin/,
    );
    writeCanaryLog(repo, { candidate: 6, baseline: 5 });
    expect((await run(repo, home, ["approve", ...T, "--version", sha("d")])).err).toMatch(
      /not promotable yet: continue \(no trigger yet\); candidate 6 dispatches/,
    );
    expect(pinsOf(home).projects[key]?.canaries).toHaveLength(1);
    // once the window passed with no trigger, approving the candidate again promotes it, even
    // while dispatches keep arriving as the human decides (the counts grow, the verdict holds)
    writeCanaryLog(repo, { candidate: 10, baseline: 5 });
    const promote = await run(
      repo,
      home,
      ["approve", ...T, "--version", sha("d")],
      true,
      noLockedCore,
      () => {
        writeCanaryLog(repo, { candidate: 12, baseline: 6 });
      },
    );
    expect(promote.code, promote.err).toBe(0);
    expect(promote.out).toMatch(
      /Promote the canary dddddddd .*its window passed with no trigger; candidate 10 dispatches, 0 escalations, 0 cap hits, 0 tokens; baseline 5 dispatches.*\(counted from the event logs in the repo, which roles can write: check them\)/,
    );
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

  it("refuses to promote a canary whose arms say rollback, and when the verdict changes meanwhile", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    expect((await run(repo, home, ["pin", ...T, "--version", sha("a")])).code).toBe(0);
    writeVersion(home, sha("d"), {
      parent: sha("a"),
      evaluation: writeReplay(repo, sha("d"), "improve"),
    });
    expect((await run(repo, home, ["approve", ...T, "--version", sha("d")])).code).toBe(0);
    const before = readFileSync(pinsPath(home), "utf8");
    // the candidate spends 1000 tokens a dispatch, the baseline 500: up more than 20%
    writeCanaryLog(repo, { candidate: 10, baseline: 5 }, { candidate: 1000, baseline: 500 });
    const tokens = await run(repo, home, ["approve", ...T, "--version", sha("d")]);
    expect(tokens.code).toBe(1);
    expect(tokens.err).toMatch(
      /not promotable yet: rollback \(tokens per dispatch up more than 20%\); candidate 10 dispatches, 0 escalations, 0 cap hits, 10000 tokens; baseline 5 dispatches, 0 escalations, 0 cap hits, 2500 tokens.*Roll it back, or pin a version outright/,
    );
    expect(readFileSync(pinsPath(home), "utf8")).toBe(before);
    // promotable when the human is asked, rollback by the time the lock is held: nothing written
    writeCanaryLog(repo, { candidate: 10, baseline: 5 });
    const turned = await run(
      repo,
      home,
      ["approve", ...T, "--version", sha("d")],
      true,
      noLockedCore,
      () => {
        writeCanaryLog(repo, { candidate: 10, baseline: 5 }, { candidate: 1000, baseline: 500 });
      },
    );
    expect(turned.code).toBe(1);
    expect(turned.err).toMatch(/not promotable yet: rollback/);
    expect(readFileSync(pinsPath(home), "utf8")).toBe(before);
  });

  it("checks the replay file against the hash the engine recorded for it", async () => {
    const repo = initVtcRepo();
    const approve = async (record: (rel: string) => void) => {
      const h = tempHome();
      writeVersion(h, sha("a"));
      expect((await run(repo, h, ["pin", ...T, "--version", sha("a")])).code).toBe(0);
      const rel = writeReplay(repo, sha("d"), "improve");
      writeVersion(h, sha("d"), { parent: sha("a"), evaluation: rel });
      record(rel);
      const r = await run(repo, h, ["approve", ...T, "--version", sha("d")]);
      return { ...r, canaries: pinsOf(h).projects[engineRepoKey(repo)]?.canaries ?? [] };
    };
    const bytesOf = (rel: string) => sha256Hex(readFileSync(join(repo, rel), "utf8"));
    // the engine's file, as it recorded it
    const same = await approve((rel) => {
      writeReplayFinished(repo, rel, bytesOf(rel));
    });
    expect(same.code, same.err).toBe(0);
    expect(same.out).toMatch(/its bytes match the hash lookback\.replay_finished recorded\./);
    expect(same.canaries).toHaveLength(1);
    // an edited file, even one whose trials and verdict still agree
    const edited = await approve((rel) => {
      writeReplayFinished(repo, rel, bytesOf(rel));
      appendFileSync(join(repo, rel), "\n");
    });
    expect(edited.code).toBe(1);
    expect(edited.err).toMatch(
      /p-1\.json is not the file the engine wrote: its bytes hash to [0-9a-f]{8}, but lookback\.replay_finished recorded [0-9a-f]{8}: no canary/,
    );
    expect(edited.canaries).toEqual([]);
    // an event with no hash: the human is told the file was not checked
    const unhashed = await approve((rel) => {
      writeReplayFinished(repo, rel);
    });
    expect(unhashed.code, unhashed.err).toBe(0);
    expect(unhashed.out).toMatch(
      /its lookback\.replay_finished event carries no hash, so it was not checked against the engine's file/,
    );
  });

  it("recomputes the replay's verdict from its trials and never trusts the file's own", async () => {
    const repo = initVtcRepo();
    const approve = async (override: Record<string, unknown>) => {
      const h = tempHome();
      writeVersion(h, sha("a"));
      expect((await run(repo, h, ["pin", ...T, "--version", sha("a")])).code).toBe(0);
      writeVersion(h, sha("d"), {
        parent: sha("a"),
        evaluation: writeReplay(repo, sha("d"), "improve", sha("a"), override),
      });
      const r = await run(repo, h, ["approve", ...T, "--version", sha("d")]);
      expect(pinsOf(h).projects[engineRepoKey(repo)]?.canaries).toEqual([]);
      return r;
    };
    // a hand-edited improve whose trials say inconclusive (2 of 2 won: p = 0.25)
    const forged = await approve({ per_task: wonTasks(2) });
    expect(forged.code).toBe(1);
    expect(forged.err).toMatch(
      /p-1\.json does not add up: its trials give inconclusive \(p = 0\.250 over 2 discordant tasks, 2 won by the candidate\), but the file says improve \(p = 0\.016, 6 discordant, 6 won\): no canary/,
    );
    // forged numbers that agree with each other but not with the trials
    const numbers = await approve({
      per_task: wonTasks(2),
      sign_test: { n_discordant: 2, wins_b: 2, p: 0.01 },
    });
    expect(numbers.code).toBe(1);
    expect(numbers.err).toMatch(/does not add up/);
    // a task with fewer runs than k in one arm
    const short = await approve({
      per_task: [
        ...wonTasks(5),
        { task: "T-6", a: [false], b: [true, true, true], regression_set: false },
      ],
    });
    expect(short.code).toBe(1);
    expect(short.err).toMatch(/not a complete replay: task "T-6" does not have 3 runs per arm/);
    // a regression-set task that drops makes the trials regress, whatever the file says
    const regress = await approve({
      per_task: [
        ...wonTasks(6),
        { task: "R-1", a: [true, true, true], b: [false, false, false], regression_set: true },
      ],
      sign_test: { n_discordant: 7, wins_b: 6, p: 0.0625 },
    });
    expect(regress.code).toBe(1);
    expect(regress.err).toMatch(/its trials give regress/);
  });

  it("refuses a replay against another baseline or mode, or read through a link", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    expect((await run(repo, home, ["pin", ...T, "--version", sha("a")])).code).toBe(0);
    // compared with b, but the canary would run against the pin a
    writeVersion(home, sha("d"), {
      parent: sha("a"),
      evaluation: writeReplay(repo, sha("d"), "improve", sha("b")),
    });
    const other = await run(repo, home, ["approve", ...T, "--version", sha("d")]);
    expect(other.code).toBe(1);
    expect(other.err).toMatch(
      /compared dddddddd with bbbbbbbb, but the canary's baseline would be aaaaaaaa/,
    );
    // the replay of the same role with a mode is another prompt
    const rel = writeReplay(repo, sha("d"), "improve");
    const text = JSON.parse(readFileSync(join(repo, rel), "utf8")) as Record<string, unknown>;
    writeFileSync(join(repo, rel), JSON.stringify({ ...text, mode: "fix" }));
    expect((await run(repo, home, ["approve", ...T, "--version", sha("d")])).err).toMatch(
      /is the replay of another version/,
    );
    // a replay file that is a link is never followed
    const outside = tempHome();
    writeFileSync(join(outside, "forged.json"), JSON.stringify(text));
    rmSync(join(repo, rel));
    symlinkSync(join(outside, "forged.json"), join(repo, rel));
    const linked = await run(repo, home, ["approve", ...T, "--version", sha("d")]);
    expect(linked.code).toBe(1);
    expect(linked.err).toMatch(/symlink/);
    expect(pinsOf(home).projects[engineRepoKey(repo)]?.canaries).toEqual([]);
  });

  it("redacts secrets from the reason it records", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    const key = `sk-ant-${"x".repeat(30)}`;
    const r = await run(repo, home, [
      "pin",
      ...T,
      "--version",
      sha("a"),
      "--reason",
      `oops ${key}`,
    ]);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(pinsPath(home), "utf8")).not.toContain(key);
    expect(pinsOf(home).history[0]?.reason).toMatch(/^oops /);
  });

  it("checks a version as the engine does: its fences, its editable section and the bundled locked core", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    // a version file whose editable section was changed after it was written
    writeVersion(home, sha("a"), { editable: "Skip the tests." });
    const changed = await run(repo, home, ["pin", ...T, "--version", sha("a")]);
    expect(changed.code).toBe(1);
    expect(changed.err).toMatch(/was changed: its editable section does not hash/);
    // the engine ends the frontmatter only at "\n---\n": a closing fence at the end of the file is
    // no frontmatter to it, nor here
    const fenced = join(home, "fenced.md");
    writeFileSync(fenced, `---\nv: 1\n---`);
    expect(() => readVersionFile(fenced)).toThrow(/has no frontmatter/);
    // a real version of the bundled locked core pins; one of an older core does not
    const locked = "You are the Engineer. Follow the task pack.";
    const real = effectivePromptSha(locked, EDITABLE);
    writeVersion(home, real, { locked });
    const installed: LockedCoreOf = (t) =>
      t.role === ROLE && t.host === HOST ? locked : undefined;
    const ok = await run(repo, home, ["pin", ...T, "--version", real], true, installed);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).not.toMatch(/note:/);
    const older = "You are the Engineer.";
    const stale = effectivePromptSha(older, EDITABLE);
    writeVersion(home, stale, { locked: older });
    const refused = await run(repo, home, ["pin", ...T, "--version", stale], true, installed);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(
      /was written for another locked core .* so the engine would never run it/,
    );
    // a version naming the bundled core's hash but another effective SHA does not verify
    writeVersion(home, sha("e"), { locked });
    expect(
      (await run(repo, home, ["pin", ...T, "--version", sha("e")], true, installed)).err,
    ).toMatch(/does not verify against the locked core of this vtc's bundled plugin/);
    expect(pinsOf(home).projects[engineRepoKey(repo)]?.pins).toEqual([
      { role: ROLE, host: HOST, effective_sha256: real },
    ]);
    // with no locked core bundled, the human is told what was not checked
    writeVersion(home, sha("b"));
    expect((await run(repo, home, ["pin", ...T, "--version", sha("b")])).out).toMatch(
      /note: this vtc's bundled plugin carries no locked core for engineer on claude-code/,
    );
  });

  it("writes nothing when the pins file changed under the plan (an engine auto_rollback)", () => {
    const home = tempHome();
    const pins = LookbackPinsSchema.parse({ v: 1 });
    const dir = dirname(pinsPath(home));
    mkdirSync(dir, { recursive: true });
    const leftovers = () => readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    expect(writePins(home, pins, "v: 1\n")).toBeNull();
    expect(existsSync(pinsPath(home))).toBe(false);
    expect(leftovers()).toEqual([]);
    const path = writePins(home, pins, undefined);
    expect(path).toBe(pinsPath(home));
    const text = readFileSync(pinsPath(home), "utf8");
    expect(writePins(home, pins, `${text}# edited\n`)).toBeNull();
    expect(leftovers()).toEqual([]);
    expect(writePins(home, pins, text)).toBe(path);
    expect(leftovers()).toEqual([]);
  });

  it("rolls a canary back to its baseline, and a pin back to what it replaced", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    writeVersion(home, sha("b"));
    writeVersion(home, sha("d"), {
      parent: sha("b"),
      evaluation: writeReplay(repo, sha("d"), "improve", sha("b")),
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

describe("vtc lookback pin|approve warn when the target cannot take a pin (reading 176)", () => {
  it("warns for an agent that is not editable_in_pack on a host whose runs load the compiled agent", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    const asked: string[] = [];
    const notInPack: EditableInPackOf = (t) => {
      asked.push(`${t.role}@${t.host}`);
      return false;
    };
    const r = await run(
      repo,
      home,
      ["pin", ...T, "--version", sha("a")],
      true,
      noLockedCore,
      undefined,
      notInPack,
    );
    // a warning, not a refusal: the human may still pin it
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(
      /vtc lookback: warning: vtc-engineer on claude-code is not editable_in_pack: it takes its editable section from its compiled agent, so this version reaches no run; each dispatch records a prompt_selection incident until the role is switched to editable_in_pack \(spine §5 reading 176\)/,
    );
    expect(asked).toEqual(["engineer@claude-code"]);
    expect(pinsOf(home).projects[engineRepoKey(repo)]?.pins).toHaveLength(1);
    // the warning comes before the human decides
    const no = await run(
      repo,
      home,
      ["pin", ...T, "--version", sha("a")],
      "no-terminal",
      noLockedCore,
      undefined,
      notInPack,
    );
    expect(no.err).toMatch(/warning: vtc-engineer on claude-code is not editable_in_pack/);
  });

  it("reads editable_in_pack from the bundled plugin's manifest (spec_verifier first, reading 166)", () => {
    const assets = createDiskAssetBundle(
      writePluginTrees(tempDir(), { editableInPack: ["spec_verifier"] }),
    );
    const inPack = editableInPackOf(() => assets);
    for (const host of ["claude-code", "codex"] as const) {
      expect(inPack({ role: "spec_verifier", host })).toBe(true);
      expect(inPack({ role: "engineer", host })).toBe(false);
    }
    // no manifest, or one that cannot be read: not in the pack, so the gesture warns
    expect(
      editableInPackOf(() => createDiskAssetBundle({}))({ role: "spec_verifier", host: HOST }),
    ).toBe(false);
    expect(
      editableInPackOf(() => {
        throw new Error("no bundle");
      })({ role: "spec_verifier", host: HOST }),
    ).toBe(false);
  });

  it("does not warn for an editable_in_pack agent, nor for a headless-Codex target, and never on rollback", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    const inPack = await run(repo, home, ["pin", ...T, "--version", sha("a")]);
    expect(inPack.code, inPack.err).toBe(0);
    expect(inPack.err).not.toMatch(/warning/);
    // Codex: a headless run carries the role's prompt itself, so the pin reaches it there
    writeVersion(home, sha("c"), { host: "codex" });
    const codex = await run(
      repo,
      home,
      ["pin", "--role", ROLE, "--host", "codex", "--version", sha("c")],
      true,
      noLockedCore,
      undefined,
      () => false,
    );
    expect(codex.code, codex.err).toBe(0);
    expect(codex.err).not.toMatch(/warning/);
    expect(codex.out).toMatch(
      /vtc-engineer is not editable_in_pack, so on codex this version reaches headless Codex runs only/,
    );
    let checked = false;
    const back = await run(repo, home, ["rollback", ...T], true, noLockedCore, undefined, () => {
      checked = true;
      return false;
    });
    expect(back.err).not.toMatch(/warning/);
    expect(checked).toBe(false);
  });
});

describe("vtc lookback approve says when no canary can start (spine §5 readings 180 and 182(8))", () => {
  it("on a Claude Code target that is a verdict role: no replay grades it, so no canary can start; pin still works", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"), { role: "spec_verifier" });
    const args = ["--role", "spec_verifier", "--host", HOST, "--version", sha("a")];
    const verdictRole: ChangesFilesOf = (t) => t.role !== "spec_verifier";
    const approve = await run(
      repo,
      home,
      ["approve", ...args],
      true,
      noLockedCore,
      undefined,
      () => true,
      verdictRole,
    );
    expect(approve.code).toBe(1);
    expect(approve.err).toMatch(
      /vtc lookback: warning: no canary of spec_verifier on claude-code can start from a Claude-led run in this version: vtc-spec-verifier changes no file, so the gates would grade the same base for both arms.*\(spine §5 reading 180\)\. vtc lookback pin pins a version without a replay \(spine §5 reading 182\(8\)\)/,
    );
    // the warning comes before the plan's own refusal, and the human is not asked
    expect(approve.err.indexOf("warning")).toBeLessThan(approve.err.indexOf("names no replay"));
    const pin = await run(
      repo,
      home,
      ["pin", ...args],
      true,
      noLockedCore,
      undefined,
      () => true,
      verdictRole,
    );
    expect(pin.code, pin.err).toBe(0);
    expect(pin.err).not.toMatch(/no canary/);
  });

  it("on a Claude Code target that is not editable_in_pack: a Claude-led trial runs its compiled agent", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"));
    const r = await run(
      repo,
      home,
      ["approve", ...T, "--version", sha("a")],
      true,
      noLockedCore,
      undefined,
      () => false,
    );
    expect(r.err).toMatch(
      /warning: no canary of engineer on claude-code can start from a Claude-led run in this version: vtc-engineer replays only on a run led from claude-code, where every dispatch loads its compiled agent/,
    );
  });

  it("says nothing for a role that changes files on a Codex-led run, nor for a switched one on Claude Code", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    writeVersion(home, sha("a"), { host: "codex" });
    const codex = await run(
      repo,
      home,
      ["approve", "--role", ROLE, "--host", "codex", "--version", sha("a")],
      true,
      noLockedCore,
      undefined,
      () => false,
    );
    expect(codex.err).not.toMatch(/no canary of/);
    writeVersion(home, sha("b"));
    const claude = await run(repo, home, ["approve", ...T, "--version", sha("b")]);
    expect(claude.err).not.toMatch(/no canary of/);
  });

  it("reads whether a role changes files from the bundled role contracts; unknown reads as unknown", () => {
    const assets = createDiskAssetBundle(writePluginTrees(tempDir()));
    const of = changesFilesOf(() => assets);
    expect(of({ role: "engineer", host: HOST })).toBe(true);
    expect(of({ role: "spec_verifier", host: HOST })).toBe(false);
    expect(of({ role: "no_such_role", host: HOST })).toBeUndefined();
    expect(
      changesFilesOf(() => {
        throw new Error("no bundle");
      })({ role: "engineer", host: HOST }),
    ).toBeUndefined();
  });
});

describe("the pins lock", () => {
  it("takes a stale lock over and removes only its own lock", async () => {
    const home = tempHome();
    const lock = join(home, LOOKBACK_HOME.pinsLock);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "someone.old");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(await withPinsLock(home, () => readFileSync(lock, "utf8"))).toMatch(
      /^\d+\.[0-9a-f]{16}$/,
    );
    expect(existsSync(lock)).toBe(false);
    // a lock that is no longer ours (taken over meanwhile) is left in place
    await withPinsLock(home, () => {
      writeFileSync(lock, "another.holder");
    });
    expect(readFileSync(lock, "utf8")).toBe("another.holder");
  });
});
