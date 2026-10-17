/**
 * Contracts 4.7.0 (the wave-3 integration round; spine §5 readings 135–143): the teams' contract
 * proposals the integrator applied, and the integrator's own fixes.
 */
import { describe, expect, it } from "vitest";
import {
  AaNoiseRowSchema,
  CONTRACT_SCHEMAS,
  FetchRequestSchema,
  IncidentKindSchema,
  LOOKBACK_HOME,
  LookbackTiebreakRecordSchema,
  REPO_ROLE_DENIED,
  RepoKeySchema,
  RESEARCH_CACHE,
  ResearchCacheRequestRowSchema,
  ROLE_DENIED_VTC,
  VisualSummarySchema,
  VisualToolchainSchema,
} from "../src/index.js";
import { SHA } from "./fixtures.js";

const NOW = "2026-10-14T00:00:00.000Z";
const REPO_KEY = "0123456789abcdef";

describe("research fetch requests (github repo names)", () => {
  it("refuses a dot segment that would climb out of /repos/<owner>/<repo>", () => {
    for (const repo of ["../user", "./x", "nodejs/..", "nodejs/.", "../..", ".github/x", "a/.b"]) {
      expect(
        FetchRequestSchema.safeParse({ fetcher: "github", repo, what: "repo" }).success,
        repo,
      ).toBe(false);
    }
  });

  it("still accepts real owner/repo names, dots inside a name included", () => {
    for (const repo of ["nodejs/node", "vercel/next.js", "a-b/c_d.e", "x/y-"]) {
      expect(
        FetchRequestSchema.safeParse({ fetcher: "github", repo, what: "repo" }).success,
        repo,
      ).toBe(true);
    }
  });
});

describe("the research cache's request rows (reading 137)", () => {
  it("names the file and validates a row", () => {
    expect(RESEARCH_CACHE.requestsFile).toBe("requests.jsonl");
    const row = { key: SHA, request: { fetcher: "github", repo: "nodejs/node", what: "repo" } };
    expect(ResearchCacheRequestRowSchema.safeParse(row).success).toBe(true);
    expect(ResearchCacheRequestRowSchema.safeParse({ ...row, key: "nope" }).success).toBe(false);
  });
});

describe("Lookback stores under the VTC home (reading 137)", () => {
  it("keeps the tiebreak records where no role can write", () => {
    expect(LOOKBACK_HOME.tiebreaksFile).toBe("lookback/tiebreaks.jsonl");
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain("lookback/**");
  });

  it("validates a tiebreak record", () => {
    const record = {
      v: 1,
      tiebreak_key: SHA,
      repo_key: REPO_KEY,
      run: "R-1",
      trace: "a-1",
      blamed_role: null,
      recorded_at: NOW,
    };
    expect(LookbackTiebreakRecordSchema.safeParse(record).success).toBe(true);
    expect(
      LookbackTiebreakRecordSchema.safeParse({ ...record, blamed_role: "engineer" }).success,
    ).toBe(true);
    expect(LookbackTiebreakRecordSchema.safeParse({ ...record, extra: 1 }).success).toBe(false);
  });

  it("validates an A/A noise row and exports the repo key", () => {
    expect(RepoKeySchema.safeParse(REPO_KEY).success).toBe(true);
    expect(RepoKeySchema.safeParse("ABC").success).toBe(false);
    const row = {
      v: 1,
      repo_key: REPO_KEY,
      role: "engineer",
      host: "claude-code",
      baseline: SHA,
      grader_bundle_sha: SHA,
      aa_flip_rate: 0.1,
      measured_at: NOW,
    };
    expect(AaNoiseRowSchema.safeParse(row).success).toBe(true);
    expect(AaNoiseRowSchema.safeParse({ ...row, aa_flip_rate: 2 }).success).toBe(false);
  });

  it("registers the new persisted shapes as contracts", () => {
    expect(Object.keys(CONTRACT_SCHEMAS)).toEqual(
      expect.arrayContaining(["AaNoiseRow", "LookbackTiebreakRecord", "ResearchCacheRequestRow"]),
    );
  });
});

describe("a prompt selection incident (reading 137)", () => {
  it("is an incident kind", () => {
    expect(IncidentKindSchema.options).toContain("prompt_selection");
  });
});

describe("the visual toolchain (readings 124, 137)", () => {
  const summary = {
    status: "pass",
    report: ".vtc/evidence/T-1/gates/a1/visual/report.json",
    counts: {
      renders: 1,
      unreached: 0,
      axe_violations: 0,
      axe_incomplete: 0,
      style_mismatches: 0,
      diffs_over_budget: 0,
      token_lint: 0,
      detector: 0,
    },
  };
  it("is optional and one of vtc or project", () => {
    expect(VisualToolchainSchema.options).toEqual(["vtc", "project"]);
    expect(VisualSummarySchema.safeParse(summary).success).toBe(true);
    expect(VisualSummarySchema.safeParse({ ...summary, toolchain: "project" }).success).toBe(true);
    expect(VisualSummarySchema.safeParse({ ...summary, toolchain: "store" }).success).toBe(false);
  });
});

describe("the run event logs are engine-only (reading 137)", () => {
  it("no role writes .vtc/runs", () => {
    expect(REPO_ROLE_DENIED.writeDeny).toContain(".vtc/runs/**");
  });
});
