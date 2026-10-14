/**
 * The engine's tiebreak store (`LOOKBACK_HOME.tiebreaksFile`, spine §5 readings 137 and 175): the
 * writer appends one validated line with O_APPEND, creates the file 0600 and refuses symbolic
 * links; the reader returns a project's keys, skipping lines that do not parse; Lookback trusts an
 * `ai_tiebreak` row only when its key is there.
 */
import {
  engineRepoKey,
  LOOKBACK_HOME,
  lookbackTiebreakKey,
  type LookbackTiebreakRecord,
} from "@vtc/shared";
import { appendFile, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAttributions,
  appendTiebreakRecord,
  buildTraces,
  graderBundleSha,
  lookbackAtRunEnd,
  readTiebreakKeys,
  tiebreakAttribution,
  tiebreakKey,
  tiebreaksPath,
} from "../../src/lookback/index.js";
import { lockedShaFor, RunLog, tempDir } from "./log.js";

const REPO = "0123456789abcdef";
const now = new Date("2026-10-14T18:00:00.000Z");

const record = (over: Partial<LookbackTiebreakRecord> = {}): LookbackTiebreakRecord => ({
  v: 1,
  tiebreak_key: "a".repeat(64),
  repo_key: REPO,
  run: "r1",
  trace: "a-1",
  blamed_role: "engineer",
  recorded_at: now.toISOString(),
  ...over,
});

describe("appendTiebreakRecord", () => {
  it("creates the store with mode 0600 and appends one line per record", async () => {
    const home = await tempDir("tb-home");
    await appendTiebreakRecord(home, record());
    await appendTiebreakRecord(home, record({ tiebreak_key: "b".repeat(64), blamed_role: null }));
    const path = join(home, LOOKBACK_HOME.tiebreaksFile);
    expect(tiebreaksPath(home)).toBe(path);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      record(),
      record({ tiebreak_key: "b".repeat(64), blamed_role: null }),
    ]);
  });

  it("refuses an invalid record and writes nothing", async () => {
    const home = await tempDir("tb-home");
    await expect(
      appendTiebreakRecord(home, record({ tiebreak_key: "not-a-sha" })),
    ).rejects.toThrow();
    await expect(
      appendTiebreakRecord(home, { ...record(), extra: 1 } as LookbackTiebreakRecord),
    ).rejects.toThrow();
    await expect(stat(tiebreaksPath(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symbolic link at the file or its directory",
    async () => {
      const home = await tempDir("tb-home");
      const elsewhere = await tempDir("tb-elsewhere");
      await mkdir(join(home, "lookback"), { recursive: true });
      const target = join(elsewhere, "target.jsonl");
      await writeFile(target, "");
      await symlink(target, tiebreaksPath(home));
      await expect(appendTiebreakRecord(home, record())).rejects.toThrow(/symbolic link/);
      expect(await readFile(target, "utf8")).toBe("");

      const home2 = await tempDir("tb-home");
      await symlink(elsewhere, join(home2, "lookback"));
      await expect(appendTiebreakRecord(home2, record())).rejects.toThrow(/plain directory/);
      await expect(stat(join(elsewhere, "tiebreaks.jsonl"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe("readTiebreakKeys", () => {
  it("returns the project's keys and skips lines that do not parse", async () => {
    const home = await tempDir("tb-home");
    await appendTiebreakRecord(home, record());
    await appendTiebreakRecord(
      home,
      record({ tiebreak_key: "c".repeat(64), repo_key: "f".repeat(16) }),
    );
    await appendFile(tiebreaksPath(home), "{torn line\n");
    await appendFile(tiebreaksPath(home), `${JSON.stringify({ ...record(), v: 9 })}\n`);
    await appendTiebreakRecord(home, record({ tiebreak_key: "d".repeat(64) }));
    expect(await readTiebreakKeys(home, REPO)).toEqual(new Set(["a".repeat(64), "d".repeat(64)]));
    expect(await readTiebreakKeys(home, "f".repeat(16))).toEqual(new Set(["c".repeat(64)]));
    expect(await readTiebreakKeys(home, "not-a-key")).toEqual(new Set());
  });

  it("is empty without a store, and for a store that is a symbolic link", async () => {
    const home = await tempDir("tb-home");
    expect(await readTiebreakKeys(home, REPO)).toEqual(new Set());
    if (process.platform === "win32") return;
    const elsewhere = await tempDir("tb-elsewhere");
    const planted = join(elsewhere, "planted.jsonl");
    await writeFile(planted, `${JSON.stringify(record())}\n`);
    await mkdir(join(home, "lookback"), { recursive: true });
    await symlink(planted, tiebreaksPath(home));
    expect(await readTiebreakKeys(home, REPO)).toEqual(new Set());
  });
});

describe("tiebreak keys", () => {
  /** A run whose engineer task parked on its cap with no signal: inconclusive, for a tiebreak. */
  const parkedRun = () => {
    const log = new RunLog("r1");
    for (let i = 1; i <= 6; i += 1) {
      const task = `T-${String(i)}`;
      log.taskCreated(task, "backend", ["node"]);
      log.dispatch("engineer", { task, tokens: 2000 });
      log.gate(task, true);
    }
    const parked = log.dispatch("engineer", { task: "T-99", tokens: 2000 });
    log.status("T-99", "fixing", "parked", 4, "cap");
    const trace = buildTraces(log.events, lockedShaFor).find((t) => t.trace === parked);
    if (trace === undefined) throw new Error("no trace");
    const tiebreak = tiebreakAttribution({
      trace,
      blamed: "engineer",
      confidence: 0.6,
      evidence: [],
      now,
    });
    if (tiebreak === undefined) throw new Error("unversioned");
    return { log, tiebreak };
  };

  it("are @vtc/shared's lookbackTiebreakKey (the same digest)", () => {
    const { tiebreak } = parkedRun();
    expect(tiebreakKey).toBe(lookbackTiebreakKey);
    expect(tiebreakKey(tiebreak)).toBe(lookbackTiebreakKey(tiebreak));
    expect(tiebreakKey(tiebreak)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("let lookbackAtRunEnd trust an ai_tiebreak row only when the store under vtcHome records it", async () => {
    const { log, tiebreak } = parkedRun();
    const runEnd = async (recorded: boolean) => {
      const root = await tempDir("tb-project");
      const home = await tempDir("tb-home");
      await appendAttributions(root, [tiebreak]);
      if (recorded)
        await appendTiebreakRecord(home, {
          v: 1,
          tiebreak_key: lookbackTiebreakKey(tiebreak),
          repo_key: engineRepoKey(root),
          run: tiebreak.run,
          trace: tiebreak.trace,
          blamed_role: tiebreak.blamed_role,
          recorded_at: now.toISOString(),
        });
      return lookbackAtRunEnd({
        projectRoot: root,
        vtcHome: home,
        events: log.events,
        history: log.events,
        lockedShaFor,
        graderBundleSha: graderBundleSha({ judgeModel: null, gatesConfigHash: null }),
        weeklyRemainingPct: 80,
        budgetAvailable: true,
        now,
      });
    };
    const failures = (cards: Awaited<ReturnType<typeof runEnd>>["scorecards"]) =>
      JSON.stringify(cards.map((c) => c.metrics));
    const without = await runEnd(false);
    const withRecord = await runEnd(true);
    expect(failures(withRecord.scorecards)).not.toBe(failures(without.scorecards));
  });
});
