/** The dedupe table, caps and the auto-close sweep (AD-27 rule 4; spine §5 reading 208 (3)). */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AutoIssueRef, AutoPrRef } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideIssue,
  isMaterialChange,
  issueCapReached,
  ledgerPath,
  openLedger,
  planPrCap,
  planQuietSweep,
  planStalePrs,
} from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const FP = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const NOW = new Date("2026-10-15T12:00:00Z");
const REPO = "bason-labs/bs-vtc";

const issue = (over: Partial<AutoIssueRef> & { number: number }): AutoIssueRef => ({
  url: `https://github.com/o/r/issues/${String(over.number)}`,
  state: "open",
  stateReason: null,
  labels: ["vtc:auto"],
  marker: { v: 1, kind: "defect", fp: FP },
  updatedAt: "2026-10-14T00:00:00Z",
  humanActivity: false,
  ...over,
});

const pr = (over: Partial<AutoPrRef> & { number: number }): AutoPrRef => ({
  url: `https://github.com/o/r/pull/${String(over.number)}`,
  headRefName: "vtc/auto/defect/01234567",
  headSha: "a".repeat(40),
  isDraft: true,
  state: "open",
  labels: ["vtc:auto"],
  marker: { v: 1, kind: "defect", fp: FP },
  ...over,
});

describe("the dedupe table", () => {
  const ledger = (): ReturnType<typeof openLedger> => openLedger(join(tempDir(), "ledger.jsonl"));

  it("creates when no issue carries the fingerprint", () => {
    expect(
      decideIssue({
        fingerprint: FP,
        issues: [issue({ number: 1, marker: { v: 1, kind: "defect", fp: OTHER } })],
        now: NOW,
        material: true,
      }),
    ).toEqual({ action: "create" });
  });

  it("updates an open issue, commenting only on a material change and once per 24 h", () => {
    const open = [issue({ number: 3 })];
    expect(decideIssue({ fingerprint: FP, issues: open, now: NOW, material: true })).toEqual({
      action: "update",
      number: 3,
      comment: true,
    });
    expect(decideIssue({ fingerprint: FP, issues: open, now: NOW, material: false })).toEqual({
      action: "update",
      number: 3,
      comment: false,
    });
    const l = ledger();
    l.append({
      repo: REPO,
      fp: FP,
      kind: "defect",
      event: "issue_updated",
      number: 3,
      at: "2026-10-15T01:00:00Z",
    });
    expect(
      decideIssue({
        fingerprint: FP,
        issues: open,
        record: l.record(REPO, FP),
        now: NOW,
        material: true,
      }),
    ).toEqual({ action: "skip", reason: "duplicate", number: 3 });
    expect(
      decideIssue({
        fingerprint: FP,
        issues: open,
        record: l.record(REPO, FP),
        now: new Date("2026-10-16T01:00:01Z"),
        material: true,
      }),
    ).toEqual({ action: "update", number: 3, comment: true });
  });

  it("never raises a muted fingerprint again: closed not planned by a human, or vtc:muted", () => {
    expect(
      decideIssue({
        fingerprint: FP,
        issues: [issue({ number: 4, state: "closed", stateReason: "not_planned" })],
        now: NOW,
        material: true,
      }),
    ).toEqual({ action: "skip", reason: "muted", number: 4 });
    expect(
      decideIssue({
        fingerprint: FP,
        issues: [issue({ number: 5, labels: ["vtc:auto", "vtc:muted"] })],
        now: NOW,
        material: true,
      }),
    ).toEqual({ action: "skip", reason: "muted", number: 5 });
    expect(
      decideIssue({
        fingerprint: FP,
        issues: [
          issue({
            number: 5,
            state: "closed",
            stateReason: "completed",
            labels: ["vtc:auto", "vtc:muted"],
          }),
        ],
        now: NOW,
        material: true,
      }),
    ).toMatchObject({ action: "skip", reason: "muted" });
  });

  it("opens a linked regression when a closed-as-completed fingerprint recurs", () => {
    expect(
      decideIssue({
        fingerprint: FP,
        issues: [
          issue({ number: 2, state: "closed", stateReason: "completed" }),
          issue({ number: 6, state: "closed", stateReason: "completed" }),
        ],
        now: NOW,
        material: true,
      }),
    ).toEqual({ action: "regression", of: 6 });
  });

  it("reopens an issue the quiet sweep closed when it recurs", () => {
    const l = ledger();
    l.append({
      repo: REPO,
      fp: FP,
      kind: "defect",
      event: "closed_quiet",
      number: 7,
      at: "2026-10-01T00:00:00Z",
    });
    expect(
      decideIssue({
        fingerprint: FP,
        issues: [issue({ number: 7, state: "closed", stateReason: "not_planned" })],
        record: l.record(REPO, FP),
        now: NOW,
        material: true,
      }),
    ).toEqual({ action: "reopen", number: 7 });
  });

  it("reopens VTC's quiet close the remote shows, with no ledger (another machine)", () => {
    const closed = issue({ number: 7, state: "closed", stateReason: "not_planned" });
    expect(
      decideIssue({
        fingerprint: FP,
        issues: [{ ...closed, closedQuietByVtc: true }],
        now: NOW,
        material: true,
      }),
    ).toEqual({ action: "reopen", number: 7 });
    expect(
      decideIssue({
        fingerprint: FP,
        issues: [{ ...closed, closedQuietByVtc: false }],
        now: NOW,
        material: true,
      }),
    ).toEqual({ action: "skip", reason: "muted", number: 7 });
  });

  it("counts a change as material on a new VTC version or when the count crosses 10 or 100", () => {
    const l = ledger();
    for (let i = 0; i < 9; i += 1) {
      l.append({
        repo: REPO,
        fp: FP,
        kind: "defect",
        event: "seen",
        version: "0.4.0",
        at: "2026-10-14T00:00:00Z",
      });
    }
    l.append({
      repo: REPO,
      fp: FP,
      kind: "defect",
      event: "commented",
      number: 1,
      at: "2026-10-14T00:00:00Z",
    });
    expect(isMaterialChange(l.record(REPO, FP), "0.4.0")).toBe(false);
    expect(isMaterialChange(l.record(REPO, FP), "0.5.0")).toBe(true);
    l.append({
      repo: REPO,
      fp: FP,
      kind: "defect",
      event: "seen",
      version: "0.4.0",
      at: "2026-10-14T00:00:00Z",
    });
    expect(isMaterialChange(l.record(REPO, FP), "0.4.0")).toBe(true);
  });
});

describe("caps", () => {
  it("allows five new issues per repo per UTC day", () => {
    const l = openLedger(join(tempDir(), "ledger.jsonl"));
    for (let n = 1; n <= 5; n += 1) {
      expect(issueCapReached(l, REPO, NOW)).toBe(false);
      l.append({
        repo: REPO,
        fp: FP,
        kind: "defect",
        event: "issue_opened",
        number: n,
        at: "2026-10-15T0" + String(n) + ":00:00Z",
      });
    }
    expect(issueCapReached(l, REPO, NOW)).toBe(true);
    expect(issueCapReached(l, "o/other", NOW)).toBe(false);
    expect(issueCapReached(l, REPO, new Date("2026-10-16T00:00:00Z"))).toBe(false);
  });

  it("counts today's automatic issues from the remote listing too (every installation)", () => {
    const l = openLedger(join(tempDir(), "ledger.jsonl"));
    const listed = [1, 2, 3, 4, 5].map((n) => ({
      ...issue({ number: n }),
      createdAt: `2026-10-15T0${String(n)}:00:00Z`,
    }));
    expect(issueCapReached(l, REPO, NOW, listed)).toBe(true);
    expect(issueCapReached(l, REPO, NOW, listed.slice(1))).toBe(false);
    const yesterday = listed.map((i) => ({ ...i, createdAt: "2026-10-14T23:00:00Z" }));
    expect(issueCapReached(l, REPO, NOW, yesterday)).toBe(false);
    const unmarked = listed.map((i) => ({ ...i, marker: null }));
    expect(issueCapReached(l, REPO, NOW, unmarked)).toBe(false);
  });

  it("allows three open automatic PRs per kind", () => {
    const open = [1, 2, 3].map((n) =>
      pr({ number: n, marker: { v: 1, kind: "defect", fp: String(n).repeat(16) } }),
    );
    expect(planPrCap({ open, kind: "defect", fingerprint: FP })).toEqual({
      action: "skip",
      reason: "rate_limit",
      detail: "3 open automatic defect PRs",
    });
    expect(planPrCap({ open, kind: "cost", fingerprint: FP })).toEqual({
      action: "open",
      supersede: [],
    });
  });

  it("keeps one open Lookback PR per role by superseding the older one", () => {
    const old = pr({
      number: 8,
      marker: { v: 1, kind: "lookback", fp: OTHER, role: "implementer" },
    });
    const other = pr({ number: 9, marker: { v: 1, kind: "lookback", fp: FP, role: "reviewer" } });
    expect(
      planPrCap({ open: [old, other], kind: "lookback", fingerprint: FP, role: "implementer" }),
    ).toEqual({ action: "open", supersede: [old] });
  });

  it("skips a duplicate PR for a fingerprint that already has one open", () => {
    expect(planPrCap({ open: [pr({ number: 4 })], kind: "defect", fingerprint: FP })).toMatchObject(
      {
        action: "skip",
        reason: "duplicate",
      },
    );
  });
});

describe("the auto-close sweep", () => {
  const old = "2026-09-20T00:00:00Z";
  it("closes issues quiet for 14 days, except vtc:keep, human activity or an open PR", () => {
    const l = openLedger(join(tempDir(), "ledger.jsonl"));
    const fps = [
      "1111111111111111",
      "2222222222222222",
      "3333333333333333",
      "4444444444444444",
      "5555555555555555",
    ];
    const issues = fps.map((fp, i) =>
      issue({ number: i + 1, updatedAt: old, marker: { v: 1, kind: "defect", fp } }),
    );
    const kept = { ...issues[1]!, labels: ["vtc:auto", "vtc:keep"] };
    const human = { ...issues[2]!, humanActivity: true };
    const withPr = issues[3]!;
    const recent = issues[4]!;
    l.append({
      repo: REPO,
      fp: fps[4]!,
      kind: "defect",
      event: "seen",
      at: "2026-10-10T00:00:00Z",
    });
    const close = planQuietSweep({
      repo: REPO,
      issues: [
        issues[0]!,
        kept,
        human,
        withPr,
        recent,
        issue({ number: 9, state: "closed", updatedAt: old }),
      ],
      openPrs: [pr({ number: 20, marker: { v: 1, kind: "defect", fp: fps[3]! } })],
      ledger: l,
      now: NOW,
    });
    expect(close.map((i) => i.number)).toEqual([1]);
  });

  it("closes automatic PRs whose issue is closed", () => {
    const stale = planStalePrs({
      issues: [
        issue({ number: 1, state: "closed", stateReason: "not_planned" }),
        issue({ number: 2, marker: { v: 1, kind: "defect", fp: OTHER } }),
      ],
      openPrs: [
        pr({ number: 10 }),
        pr({ number: 11, marker: { v: 1, kind: "defect", fp: OTHER } }),
      ],
    });
    expect(stale.map((p) => p.number)).toEqual([10]);
  });
});

describe("the ledger", () => {
  it("lives at <vtcHome>/upstream or .vtc/state/automation, private and redacted", () => {
    expect(ledgerPath({ kind: "upstream", vtcHome: "/h/.vtc" })).toBe(
      "/h/.vtc/upstream/ledger.jsonl",
    );
    expect(ledgerPath({ kind: "project", repoRoot: "/p" })).toBe(
      "/p/.vtc/state/automation/ledger.jsonl",
    );
    const path = join(tempDir(), "upstream", "ledger.jsonl");
    const l = openLedger(path, ["supersecretvalue1"]);
    l.append({
      repo: REPO,
      fp: FP,
      kind: "defect",
      event: "seen",
      version: "supersecretvalue1",
      at: NOW.toISOString(),
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("supersecretvalue1");
    expect(l.record(REPO, FP)?.count).toBe(1);
  });
  it("skips lines that do not parse and refuses a symlink", () => {
    const dir = tempDir();
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, "not json\n");
    const l = openLedger(path);
    expect(l.record(REPO, FP)).toBeUndefined();
    const link = join(dir, "link.jsonl");
    symlinkSync(path, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => {
      openLedger(link).append({
        repo: REPO,
        fp: FP,
        kind: "defect",
        event: "seen",
        at: NOW.toISOString(),
      });
    }).toThrow(/symlink/);
  });
  it("never writes through a symlinked directory below its root (a role-planted link)", () => {
    const root = tempDir("vtc-project-");
    const elsewhere = tempDir("vtc-elsewhere-");
    mkdirSync(join(root, ".vtc", "state"), { recursive: true });
    symlinkSync(elsewhere, join(root, ".vtc", "state", "automation"));
    const path = ledgerPath({ kind: "project", repoRoot: root });
    expect(() => {
      openLedger(path, [], root).append({
        repo: REPO,
        fp: FP,
        kind: "defect",
        event: "seen",
        at: NOW.toISOString(),
      });
    }).toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
