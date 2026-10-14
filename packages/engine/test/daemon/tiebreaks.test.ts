/**
 * The engine's record of AI tiebreak answers (`LOOKBACK_HOME.tiebreaksFile`; spine §5 readings
 * 137 and 175): append-only, private, never through a symlink, keyed with `lookbackTiebreakKey`,
 * and read back per project.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttributionSchema,
  effectivePromptSha,
  LOOKBACK_HOME,
  lookbackTiebreakKey,
  sha256Hex,
  type Attribution,
} from "@vtc/shared";
import { readTiebreakKeys, recordTiebreak, tiebreaksPath } from "../../src/daemon/tiebreaks.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const REPO = "a".repeat(16);
const NOW = new Date("2026-10-14T12:00:00.000Z");

const row = (over: Partial<Attribution> = {}): Attribution =>
  AttributionSchema.parse({
    v: 1,
    trace: "a-3",
    run: "r-1",
    task: "T-1",
    prompt: {
      role: "engineer",
      host: "claude-code",
      locked_sha256: sha256Hex("locked"),
      editable_sha256: sha256Hex("editable"),
      effective_sha256: effectivePromptSha("locked", "editable"),
    },
    outcome: "failure",
    blamed_role: "engineer",
    method: "ai_tiebreak",
    confidence: 0.7,
    split: "train",
    evidence: [{ type: "file", ref: ".vtc/evidence/T-1/round-1.json" }],
    attributed_at: NOW.toISOString(),
    ...over,
  });

describe("the AI tiebreak store (readings 137, 175)", () => {
  it("appends one private record per answer and reads its keys back per project", () => {
    const home = tempDir();
    recordTiebreak(home, REPO, row(), NOW);
    recordTiebreak(home, REPO, row({ trace: "a-4", blamed_role: null }), NOW);
    recordTiebreak(home, "b".repeat(16), row({ trace: "a-5" }), NOW);
    const path = tiebreaksPath(home);
    expect(path).toBe(join(home, LOOKBACK_HOME.tiebreaksFile));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      v: 1,
      tiebreak_key: lookbackTiebreakKey(row()),
      repo_key: REPO,
      run: "r-1",
      trace: "a-3",
      blamed_role: "engineer",
      recorded_at: NOW.toISOString(),
    });
    // a line that does not parse is skipped; another project's records are not this one's
    appendFileSync(path, "{not json\n");
    expect(readTiebreakKeys(home, REPO)).toEqual(
      new Set([
        lookbackTiebreakKey(row()),
        lookbackTiebreakKey(row({ trace: "a-4", blamed_role: null })),
      ]),
    );
    // the attributed_at and split of a row do not re-key it
    expect(readTiebreakKeys(home, REPO).has(lookbackTiebreakKey(row({ split: "holdout" })))).toBe(
      true,
    );
  });

  it("records only ai_tiebreak rows", () => {
    expect(() => {
      recordTiebreak(tempDir(), REPO, row({ method: "tree", rule: "test_fails" }), NOW);
    }).toThrow(/not an ai_tiebreak row/);
  });

  it("never writes or reads through a symlink", () => {
    const home = tempDir();
    const elsewhere = tempDir();
    symlinkSync(elsewhere, join(home, "lookback"));
    expect(() => {
      recordTiebreak(home, REPO, row(), NOW);
    }).toThrow(/symlink/);
    const other = tempDir();
    mkdirSync(join(other, "lookback"));
    const planted = join(elsewhere, "planted.jsonl");
    writeFileSync(planted, "");
    symlinkSync(planted, tiebreaksPath(other));
    expect(() => {
      recordTiebreak(other, REPO, row(), NOW);
    }).toThrow();
    expect(readFileSync(planted, "utf8")).toBe("");
    expect(readTiebreakKeys(other, REPO).size).toBe(0);
  });
});
