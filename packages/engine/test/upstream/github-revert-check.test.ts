/**
 * The H-15 (4) GitHub merge and revert check (spine §5 reading 239; §7 row "GitHub revert PRs"):
 * the Lead runs the script by hand after the round-6 merge; these tests run only its pure parts
 * (argument parsing, the throwaway-branch guard, the record shape and the detection it reports),
 * never `gh` or `git`, and never a remote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertThrowaway,
  detectRevert,
  parseRevertCheckArgs,
  revertBranchOf,
  RevertCheckRecordSchema,
  safeGhArgs,
  throwawayBranches,
  type RevertCheckRecord,
} from "./live/github-revert-check.js";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const FIXTURE = join(REPO_ROOT, "fixtures/upstream-evidence/github-revert/revert.synthetic.json");

const fixture = (): RevertCheckRecord =>
  RevertCheckRecordSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

describe("arguments", () => {
  it("is a dry run unless --run is given, on bs-vtc only", () => {
    expect(parseRevertCheckArgs(["--repo", "bason-labs/bs-vtc"])).toEqual({
      repo: "bason-labs/bs-vtc",
      from: "build/foundation",
      method: "merge",
      revertVia: "api",
      autoProbe: true,
      run: false,
      keep: false,
    });
    expect(
      parseRevertCheckArgs([
        "--repo",
        "bason-labs/bs-vtc",
        "--run",
        "--method",
        "squash",
        "--revert-via",
        "button",
        "--no-auto-probe",
        "--keep",
        "--record",
        "/tmp/x.json",
      ]),
    ).toMatchObject({
      run: true,
      method: "squash",
      revertVia: "button",
      autoProbe: false,
      keep: true,
      record: "/tmp/x.json",
    });
    for (const bad of [
      [],
      ["--repo", "bason-labs/payroll"],
      ["--repo", "bs-vtc"],
      ["--repo", "bason-labs/bs-vtc", "--method", "admin"],
      ["--repo", "bason-labs/bs-vtc", "--revert-via", "cli"],
      ["--repo", "bason-labs/bs-vtc", "--force"],
      ["--repo", "bason-labs/bs-vtc", "--from", "-x"],
    ])
      expect(() => parseRevertCheckArgs(bad), bad.join(" ")).toThrow();
  });
});

describe("throwaway branches only (H-15: never master or build/foundation)", () => {
  it("names both branches under vtc-h15/<stamp>/", () => {
    expect(throwawayBranches(new Date("2026-10-16T09:08:07Z"))).toEqual({
      stamp: "20261016T090807Z",
      base: "vtc-h15/20261016T090807Z/base",
      feature: "vtc-h15/20261016T090807Z/feature",
    });
  });

  it("refuses to push to or delete any other branch", () => {
    const protectedNames = ["master", "build/foundation"];
    expect(() => {
      assertThrowaway("vtc-h15/20261016T090807Z/base", protectedNames);
    }).not.toThrow();
    expect(() => {
      assertThrowaway("revert-12-vtc-h15/20261016T090807Z/feature", protectedNames);
    }).not.toThrow();
    for (const name of [
      "master",
      "build/foundation",
      "main",
      "refs/heads/master",
      "vtc-h15/../master",
      "vtc-h15/x/base",
      "team/upstream",
      "revert-12-master",
      "vtc-h15/20261016T090807Z/base:refs/heads/master",
      "",
    ])
      expect(() => {
        assertThrowaway(name, protectedNames);
      }, name).toThrow(/throwaway/);
    // a protected name is refused even when it looks like a throwaway one
    expect(() => {
      assertThrowaway("vtc-h15/20261016T090807Z/base", ["vtc-h15/20261016T090807Z/base"]);
    }).toThrow(/throwaway/);
  });

  it("knows the branch GitHub's Revert button creates", () => {
    expect(revertBranchOf(12, "vtc-h15/20261016T090807Z/feature")).toBe(
      "revert-12-vtc-h15/20261016T090807Z/feature",
    );
  });

  it("never passes --admin, --force or a bypass to gh", () => {
    expect(safeGhArgs(["pr", "merge", "12", "--merge"])).toEqual(["pr", "merge", "12", "--merge"]);
    for (const bad of [
      ["pr", "merge", "12", "--admin"],
      ["pr", "merge", "12", "--merge", "--admin=true"],
      ["api", "-X", "DELETE", "repos/x/y/git/refs/heads/master"],
      ["repo", "edit", "--enable-auto-merge"],
    ])
      expect(() => safeGhArgs(bad), bad.join(" ")).toThrow();
  });
});

describe("the fixture shape and what revert detection reads from it", () => {
  it("parses the synthetic record of the shape the Lead's run writes", () => {
    const record = fixture();
    expect(record.kind).toBe("synthetic");
    expect(record.revert.title).toBe(`Revert "${record.merge.title}"`);
    expect(record.revert.body).toContain(`#${String(record.merge.pr)}`);
  });

  it("finds the revert by both AD-23 rule 4 reads (git log and the PR reference)", () => {
    const record = fixture();
    expect(detectRevert(record)).toEqual({ git_log: true, pr_reference: true });
    expect(record.detection).toEqual(detectRevert(record));
  });

  it("reports which read misses when GitHub's shape differs", () => {
    const record = fixture();
    expect(
      detectRevert({
        ...record,
        revert: {
          ...record.revert,
          title: `Back out "${record.merge.title}"`,
          commits: record.revert.commits.map((c) => ({ ...c, message: "Back out the probe" })),
        },
      }),
    ).toEqual({ git_log: false, pr_reference: false });
    // a mention of #12 is not a mention of #1
    expect(
      detectRevert({
        ...record,
        merge: { ...record.merge, pr: 1 },
        revert: { ...record.revert, body: "Reverts bason-labs/bs-vtc#12" },
      }).pr_reference,
    ).toBe(false);
  });
});
