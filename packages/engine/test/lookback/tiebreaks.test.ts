/**
 * The engine's tiebreak store (`LOOKBACK_HOME.tiebreaksFile`, spine §5 readings 137 and 175): the
 * writer appends one validated line with O_APPEND, creates the file 0600 and refuses symbolic
 * links; the reader returns a project's keys, skipping lines that do not parse; Lookback trusts an
 * `ai_tiebreak` row only when its key is there.
 */
import { engineRepoKey, LOOKBACK_HOME, lookbackTiebreakKey, type Attribution } from "@vtc/shared";
import { appendFile, chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAttributions,
  appendTiebreakRecord,
  buildTraces,
  graderBundleSha,
  lookbackAtRunEnd,
  readTiebreakKeys,
  TIEBREAK_STORE_MAX_BYTES,
  tiebreakAttribution,
  tiebreakKey,
  tiebreakRecordFor,
  tiebreaksPath,
  type TiebreakAnswer,
} from "../../src/lookback/index.js";
import { lockedShaFor, RunLog, tempDir } from "./log.js";

const REPO = "0123456789abcdef";
const now = new Date("2026-10-14T18:00:00.000Z");

/** An `ai_tiebreak` attribution row. */
const row = (over: Partial<Attribution> = {}): Attribution => ({
  v: 1,
  trace: "a-1",
  run: "r1",
  prompt: {
    role: "engineer",
    host: "claude-code",
    locked_sha256: "1".repeat(64),
    editable_sha256: "2".repeat(64),
    effective_sha256: "3".repeat(64),
  },
  outcome: "failure",
  blamed_role: "engineer",
  method: "ai_tiebreak",
  confidence: 0.6,
  split: "train",
  evidence: [],
  attributed_at: now.toISOString(),
  ...over,
});

const answer = (over: Partial<Attribution> = {}, repoKey = REPO): TiebreakAnswer => ({
  attribution: row(over),
  repo_key: repoKey,
  recorded_at: now.toISOString(),
});

describe("appendTiebreakRecord", () => {
  it("keys each record with lookbackTiebreakKey of its row, creates the store 0600 and appends one line per answer", async () => {
    const home = await tempDir("tb-home");
    const first = await appendTiebreakRecord(home, answer());
    const second = await appendTiebreakRecord(home, answer({ trace: "a-2", blamed_role: null }));
    expect(first).toEqual({
      v: 1,
      tiebreak_key: lookbackTiebreakKey(row()),
      repo_key: REPO,
      run: "r1",
      trace: "a-1",
      blamed_role: "engineer",
      recorded_at: now.toISOString(),
    });
    expect(second).toMatchObject({
      tiebreak_key: lookbackTiebreakKey(row({ trace: "a-2", blamed_role: null })),
      trace: "a-2",
      blamed_role: null,
    });
    const path = join(home, LOOKBACK_HOME.tiebreaksFile);
    expect(tiebreaksPath(home)).toBe(path);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([first, second]);
  });

  it("refuses an invalid answer or a row that is not an ai_tiebreak, and writes nothing", async () => {
    const home = await tempDir("tb-home");
    await expect(appendTiebreakRecord(home, answer({}, "not-a-key"))).rejects.toThrow();
    await expect(
      appendTiebreakRecord(home, { ...answer(), recorded_at: "yesterday" }),
    ).rejects.toThrow();
    await expect(appendTiebreakRecord(home, answer({ method: "human" }))).rejects.toThrow(
      /ai_tiebreak/,
    );
    await expect(
      appendTiebreakRecord(home, answer({ extra: 1 } as Partial<Attribution>)),
    ).rejects.toThrow();
    await expect(stat(tiebreaksPath(home))).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => tiebreakRecordFor(answer({ method: "human" }))).toThrow(/ai_tiebreak/);
  });

  it.skipIf(process.platform === "win32")(
    "tightens a store with looser permissions to 0600",
    async () => {
      const home = await tempDir("tb-home");
      await mkdir(join(home, "lookback"), { recursive: true });
      await writeFile(tiebreaksPath(home), "");
      await chmod(tiebreaksPath(home), 0o644);
      await appendTiebreakRecord(home, answer());
      expect((await stat(tiebreaksPath(home))).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a symbolic link at the file or its directory",
    async () => {
      const home = await tempDir("tb-home");
      const elsewhere = await tempDir("tb-elsewhere");
      await mkdir(join(home, "lookback"), { recursive: true });
      const target = join(elsewhere, "target.jsonl");
      await writeFile(target, "");
      await symlink(target, tiebreaksPath(home));
      await expect(appendTiebreakRecord(home, answer())).rejects.toThrow(/symbolic link/);
      expect(await readFile(target, "utf8")).toBe("");

      const home2 = await tempDir("tb-home");
      await symlink(elsewhere, join(home2, "lookback"));
      await expect(appendTiebreakRecord(home2, answer())).rejects.toThrow(/plain directory/);
      await expect(stat(join(elsewhere, "tiebreaks.jsonl"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe("readTiebreakKeys", () => {
  it("returns the project's keys and skips lines that do not parse", async () => {
    const home = await tempDir("tb-home");
    const a = await appendTiebreakRecord(home, answer());
    const c = await appendTiebreakRecord(home, answer({ trace: "c-1" }, "f".repeat(16)));
    await appendFile(tiebreaksPath(home), "{torn line\n");
    await appendFile(tiebreaksPath(home), `${JSON.stringify({ ...a, v: 9 })}\n`);
    const d = await appendTiebreakRecord(home, answer({ trace: "d-1" }));
    expect(await readTiebreakKeys(home, REPO)).toEqual(new Set([a.tiebreak_key, d.tiebreak_key]));
    expect(await readTiebreakKeys(home, "f".repeat(16))).toEqual(new Set([c.tiebreak_key]));
    expect(await readTiebreakKeys(home, "not-a-key")).toEqual(new Set());
  });

  it("is empty without a store, and for a store that is a symbolic link", async () => {
    const home = await tempDir("tb-home");
    expect(await readTiebreakKeys(home, REPO)).toEqual(new Set());
    if (process.platform === "win32") return;
    const elsewhere = await tempDir("tb-elsewhere");
    const planted = join(elsewhere, "planted.jsonl");
    await writeFile(planted, `${JSON.stringify(tiebreakRecordFor(answer()))}\n`);
    await mkdir(join(home, "lookback"), { recursive: true });
    await symlink(planted, tiebreaksPath(home));
    expect(await readTiebreakKeys(home, REPO)).toEqual(new Set());
  });

  it("is empty (fail closed) for a store over the byte cap", async () => {
    const home = await tempDir("tb-home");
    await appendTiebreakRecord(home, answer());
    expect((await readTiebreakKeys(home, REPO)).size).toBe(1);
    await appendFile(tiebreaksPath(home), " ".repeat(TIEBREAK_STORE_MAX_BYTES));
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
          attribution: tiebreak,
          repo_key: engineRepoKey(root),
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
