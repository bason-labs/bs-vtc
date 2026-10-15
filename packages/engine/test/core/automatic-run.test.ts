/**
 * Automatic runs (AD-27 rule 2; D-cd, D-bw, H-7; spine §5 readings 187, 191 and 198): a normal run
 * started from an automatic issue, marked `run.started.automation`. Its issue is the spec, so the
 * human gates G1 and G2 are skipped (the engine records them approved), the Spec Verifier reads
 * the issue, it never runs at merge Level 3, and every gate, review and risk rule still applies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoBranchName,
  MERGE_LEVEL_LEDGER,
  PACK_INPUT_TYPES,
  parseEventLog,
  TaskPackSchema,
  type VtcEvent,
} from "@vtc/shared";
import { automaticReleaseOf, projectRun } from "../../src/core/index.js";
import { cleanupDirs, git, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  spawns,
  spineFor,
  SPEC_ONE,
  submitResult,
  verdictPass,
  workdir,
  type Harness,
} from "../helpers/engine-harness.js";
import { drive, driveToRelease, frontHalf, ISSUE, REQUEST } from "../helpers/automatic-run.js";

vi.setConfig({ testTimeout: 40_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  actor: string;
  role?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

/** A spine that maps no requirement to a component: the DESIGN check fails. */
const UNMAPPED_SPINE = "# spine\n\nNo requirement map yet.\n";

describe("automatic runs (AD-27 rule 2)", () => {
  it("marks the run with its issue and skips G1 and G2: the engine approves them, no approve_gate reaches the Lead", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { seen } = await frontHalf(h);
    expect(seen.filter((a) => a.type === "approve_gate")).toEqual([]);
    const log = events(h);
    expect(log.find((e) => e.type === "run.started")?.data.automation).toEqual(ISSUE);
    const approvals = log.filter((e) => e.type === "gate.approved");
    expect(approvals.map((e) => [e.actor, e.data.gates])).toEqual([
      ["engine", ["G1"]],
      ["engine", ["G2"]],
    ]);
    expect(String(approvals[0]?.data.note)).toMatch(/issue #42 is its spec/);
    // what was approved was shown first, as for a human gate
    expect(log.filter((e) => e.type === "gate.requested")).toHaveLength(2);
    expect(h.engine.status({}).run.phase).toBe("plan");
    await h.release();
  });

  it("never approves a failed DESIGN check: the engine rejects G2 with the check's problems, and the Architect fixes it", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner, seen } = await drive(h, (n) =>
      n === 0 ? UNMAPPED_SPINE : spineFor(SPEC_ONE),
    );
    expect(planner).toBeDefined();
    expect(seen.filter((a) => a.type === "approve_gate")).toEqual([]);
    const log = events(h);
    const rejected = log.filter((e) => e.type === "gate.rejected");
    expect(rejected.map((e) => [e.actor, e.data.gates])).toEqual([["engine", ["G2"]]]);
    expect(String(rejected[0]?.data.note)).toMatch(
      /the DESIGN check failed: REQ-1 is mapped to no component/,
    );
    // the Architect ran again with the engine's note
    const architects = spawns(seen).filter((a) => a.role === "architect");
    expect(architects).toHaveLength(2);
    expect(architects[1]?.prompt).toMatch(
      /The engine rejected the gate: automatic run: the DESIGN check failed/,
    );
    // the G2 the engine approved is the one whose check passed
    const approvals = log.filter((e) => e.type === "gate.approved");
    expect(approvals.map((e) => [e.actor, e.data.gates])).toEqual([
      ["engine", ["G1"]],
      ["engine", ["G2"]],
    ]);
    expect(h.engine.status({}).run.phase).toBe("plan");
    await h.release();
  });

  it("leaves a DESIGN check that keeps failing for the human after its own bounded rejections", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner, seen } = await drive(h, () => UNMAPPED_SPINE);
    expect(planner).toBeUndefined();
    const log = events(h);
    expect(log.filter((e) => e.type === "gate.rejected").map((e) => e.actor)).toEqual([
      "engine",
      "engine",
    ]);
    expect(log.filter((e) => e.type === "gate.approved").map((e) => e.data.gates)).toEqual([
      ["G1"],
    ]);
    const gate = seen.findLast((a) => a.type === "approve_gate");
    expect(gate).toMatchObject({ type: "approve_gate", gates: ["G2"] });
    expect(h.engine.status({}).run.phase).toBe("g2");
    await h.release();
  });

  it("leaves a G2 that lists unverified facts for the human: a fact waiver needs a human's reason (AD-22 rule 4)", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const unverified = `${spineFor(SPEC_ONE)}\n## Research\n\n- UNVERIFIED: the hosting plan includes point-in-time recovery\n`;
    const { planner, seen } = await drive(h, () => unverified);
    expect(planner).toBeUndefined();
    const log = events(h);
    // G1 is the engine's; G2 is neither approved nor rejected by it
    expect(
      log.filter((e) => e.type === "gate.approved").map((e) => [e.actor, e.data.gates]),
    ).toEqual([["engine", ["G1"]]]);
    expect(log.filter((e) => e.type === "gate.rejected")).toEqual([]);
    const gate = seen.findLast((a) => a.type === "approve_gate");
    expect(gate).toMatchObject({ type: "approve_gate", gates: ["G2"] });
    expect((gate as { unverified_facts: string[] }).unverified_facts).toHaveLength(1);
    expect(h.engine.status({}).run.phase).toBe("g2");
    await h.release();
  });

  it("never runs at merge Level 3: a Level-3 project starts the automatic run at Level 2 with no Level-3 preflight", async () => {
    const h = createHarness({ project: { merge_level: 3 }, level3: true });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const log = events(h);
    expect(log.find((e) => e.type === "run.started")?.data.merge_level).toBe(2);
    expect(log.filter((e) => e.type === "merge.preflight")).toEqual([]);
    expect(h.engine.status({}).run.merge_level_effective).toBe(2);
    await h.release();
  });

  it("keeps a ledger downgrade below 2", async () => {
    const h = createHarness({ project: { merge_level: 3 }, level3: true });
    writeFile(
      h.repo,
      MERGE_LEVEL_LEDGER,
      `${JSON.stringify({ v: 1, at: "2026-10-13T08:00:00.000Z", kind: "downgrade", cap: 1, reason: "human", detail: "x" })}\n`,
    );
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    expect(events(h).find((e) => e.type === "run.started")?.data.merge_level).toBe(1);
    await h.release();
  });

  it("a run the human asked for keeps its human gates", async () => {
    const h = createHarness();
    await h.engine.start(REQUEST, CLAUDE);
    const actions = (await h.engine.next({}, CLAUDE)).actions;
    const carto = only(actions, "repo_cartographer");
    writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
    const ba = only(
      (
        await submitResult(h, carto, {
          exit: "done",
          artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
        })
      ).actions,
      "ba",
    );
    writeFile(workdir(ba), ".vtc/spec/spec.md", SPEC_ONE);
    const after = (
      await submitResult(h, ba, {
        exit: "done",
        artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
      })
    ).actions;
    expect(after.some((a) => a.type === "approve_gate")).toBe(true);
    expect(events(h).find((e) => e.type === "run.started")?.data.automation).toBeUndefined();
    await h.release();
  });

  it("pushes only to its vtc/auto branch and opens no unlabelled, evidence-less PR (AD-27 rules 1, 2, 3 and 6, H-8)", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    await driveToRelease(h);
    expect(h.engine.status({}).run.finished_at).toBeDefined();
    const branch = autoBranchName(ISSUE.kind, ISSUE.fingerprint);
    expect(branch).toBe("vtc/auto/ci_failure/01234567");
    // the work is on the remote under the automatic branch only, never vtc/F-n
    const heads = git(h.remote, "for-each-ref", "--format=%(refname)", "refs/heads/")
      .trim()
      .split("\n");
    expect(heads.sort()).toEqual(["refs/heads/main", `refs/heads/${branch}`]);
    const integration = h.engine.status({}).features[0]?.integration_branch ?? "";
    expect(git(h.remote, "rev-parse", `refs/heads/${branch}`).trim()).toBe(
      git(h.repo, "rev-parse", integration).trim(),
    );
    const pushes = events(h).filter((e) => e.type === "branch.pushed");
    expect(pushes.length).toBeGreaterThan(0);
    // the events name the integration branch whose head went to the automatic one, and the
    // automatic branch it wrote (`remote_ref`, contracts 5.4.0)
    for (const e of pushes)
      expect(e.data).toMatchObject({ branch: integration, remote_ref: branch });
    // no PR through the Level-2 seam: its draft PR is the upstream module's, labelled and with
    // evidence; until then the merged task is in no open PR
    expect(h.prs.calls).toEqual([]);
    expect(h.engine.status({}).features[0]?.pr).toBeUndefined();
    const statuses = events(h)
      .filter((e) => e.type === "task.status_changed")
      .map((e) => e.data.to);
    expect(statuses.at(-1)).toBe("merged");
    expect(statuses).not.toContain("done");
    await h.release();
  });

  it("its release push is what the upstream module opens the draft PR from: the pushed head, the issue and the Spec-Verifier verdict (AD-27 rules 2 and 6)", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    await driveToRelease(h);
    const run = h.engine.status({}).run.id;
    const log = parseEventLog(
      readFileSync(join(h.repo, `.vtc/runs/${run}/events.jsonl`), "utf8"),
    ).events;
    // each event read against the run as it was right after it (as the daemon's listener does)
    const releases = log.flatMap((e, i) => {
      const release = automaticReleaseOf(projectRun(log.slice(0, i + 1)), e);
      return release === null ? [] : [release];
    });
    // the pushes after each merge are no release: only the one after Final Review passed
    expect(log.filter((e) => e.type === "branch.pushed").length).toBeGreaterThan(1);
    expect(releases).toHaveLength(1);
    const [release] = releases;
    const branch = autoBranchName(ISSUE.kind, ISSUE.fingerprint);
    const feature = h.engine.status({}).features[0];
    expect(release).toMatchObject({
      run,
      feature: "F-1",
      automation: ISSUE,
      head: git(h.remote, "rev-parse", `refs/heads/${branch}`).trim(),
      title: feature?.title,
      specVerifier: "pass",
      change: "non_ui",
    });
    expect(release?.request).toContain("Fix the post-merge CI failure (#42)");
    expect(release?.tasks.map((t) => t.id)).toEqual(["T-1"]);
    expect(release?.steps.find((s) => s.step === 3)?.status).toBe("pass");
    expect(release?.gateReport?.reason).toBe("final_review");
    expect(release?.pr).toBeUndefined();
    // read again later, it names the PR the module opened for this issue meanwhile
    const push = log.findLast((e) => e.type === "branch.pushed") as VtcEvent;
    const opened: VtcEvent = {
      ...push,
      seq: (log.at(-1)?.seq ?? 0) + 1,
      type: "upstream.pr_opened",
      data: {
        target: ISSUE.target,
        kind: ISSUE.kind,
        fingerprint: ISSUE.fingerprint,
        number: 77,
        url: "https://github.com/acme/app/pull/77",
        branch,
        issue: 42,
        evidence: "complete",
      },
    };
    expect(automaticReleaseOf(projectRun([...log, opened]), push)?.pr).toBe(77);
    // a run the human asked for has no automatic release
    const human = projectRun(log);
    human.automation = null;
    expect(automaticReleaseOf(human, push)).toBeNull();
    await h.release();
  });

  it("records a refused push when its vtc/auto branch moved on the remote (never forced)", async () => {
    const h = createHarness({ project: { merge_level: 2 } });
    const branch = autoBranchName(ISSUE.kind, ISSUE.fingerprint);
    // a human's commit on the automatic branch, which VTC's work does not contain
    git(h.repo, "commit", "--quiet", "--allow-empty", "-m", "human");
    git(h.repo, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    const human = git(h.repo, "rev-parse", "HEAD").trim();
    git(h.repo, "reset", "--quiet", "--hard", "HEAD~1");
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner } = await frontHalf(h);
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    if (!planned.accepted) throw new Error("plan rejected");
    await h.engine.settle();
    await authorTests(h, only((await h.engine.next({}, CLAUDE)).actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    const verifier = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
    await verdictPass(h, verifier, "src/t-1/impl.ts");
    await h.engine.settle();
    const failed = events(h).filter((e) => e.type === "branch.push_failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.data.detail).toContain(`push to ${branch}`);
    expect(failed[0]?.data.remote_ref).toBe(branch);
    expect(git(h.remote, "rev-parse", `refs/heads/${branch}`).trim()).toBe(human);
    expect(h.prs.calls).toEqual([]);
    await h.release();
  });

  it("the Spec Verifier reads the issue as its automation_issue input (reading 212(16)), and every gate still runs", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    await h.engine.startAutomatic(REQUEST, ISSUE, CLAUDE);
    const { planner } = await frontHalf(h);
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    if (!planned.accepted) throw new Error("plan rejected");
    await h.engine.settle();
    const actions = (await h.engine.next({}, CLAUDE)).actions;
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    const verifier = only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier");
    const pack = TaskPackSchema.parse(
      JSON.parse(readFileSync(join(h.repo, verifier.pack.replace(/\.md$/, ".json")), "utf8")),
    );
    const run = h.engine.status({}).run.id;
    expect(pack.inputs).toContainEqual({
      type: PACK_INPUT_TYPES.automationIssue,
      path: `.vtc/runs/${run}/request.md`,
    });
    // only the engine's automation_issue input says the run is automatic, never a request input
    expect(pack.inputs.filter((i) => i.type === "request")).toEqual([]);
    // the base-fail check and the round's gates ran as for any run
    expect(h.gates.requests.map((r) => r.reason)).toEqual(
      expect.arrayContaining(["base_fail_check", "round"]),
    );
    await h.release();
  });

  it("with UI (has_ui from the issue's paths, reading 223) runs no design work: no Designer, G1 and G2 still the engine's, no prototype waited on; Visual QA judges the existing screens", async () => {
    const screens = [
      "version: 1",
      "screens:",
      "  - id: reset-request",
      "    route: /reset",
      "    states: [empty]",
      "    reqs: [REQ-1]",
      "",
    ].join("\n");
    const h = createHarness({
      project: { merge_level: 1 },
      // the project's own screens, committed: an automatic run has no Designer to write them
      files: { ".vtc/design/screens.yaml": screens },
    });
    const report = ".vtc/evidence/T-1/gates/1/visual/report.json";
    h.gates.reshape((request, gate) =>
      request.reason === "round"
        ? {
            ...gate,
            visual: {
              status: "pass",
              report,
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
              findings: [],
            },
          }
        : gate,
    );
    await h.engine.startAutomatic({ ...REQUEST, has_ui: true }, ISSUE, CLAUDE);
    const { planner, seen } = await frontHalf(h);
    expect(spawns(seen).map((a) => a.role)).not.toContain("designer");
    expect(seen.filter((a) => a.type === "approve_gate")).toEqual([]);
    expect(
      events(h)
        .filter((e) => e.type === "gate.approved")
        .map((e) => [e.actor, e.data.gates, e.data.design_exit]),
    ).toEqual([
      ["engine", ["G1"], undefined],
      ["engine", ["G2"], undefined],
    ]);
    const planned = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1", { discipline: "frontend" })] as never,
    });
    if (!planned.accepted) throw new Error("plan rejected");
    await h.engine.settle();
    await authorTests(h, only((await h.engine.next({}, CLAUDE)).actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    // the round's visual step got the project's screens; no prototype exists anywhere
    expect(h.gates.requests.find((r) => r.reason === "round")?.visual).toEqual({
      screens: ["reset-request"],
    });
    writeFile(h.repo, ".vtc/evidence/T-1/gates/1/visual/reset-390.png", "png");
    const reviewers = spawns((await h.engine.next({}, CLAUDE)).actions);
    const judges = reviewers.filter((a) => a.role === "visual_qa");
    expect(judges.length).toBeGreaterThan(0);
    const pack = TaskPackSchema.parse(
      JSON.parse(readFileSync(join(h.repo, judges[0]!.pack.replace(/\.md$/, ".json")), "utf8")),
    );
    expect(pack.inputs.some((i) => i.path.startsWith(".vtc/design/prototype"))).toBe(false);
    expect(pack.design_direction).toBeUndefined();
    await h.release();
  });

  it("a daemon-started automatic run with no Lead is driven headless only with headless_allowed; otherwise it waits for a Lead (reading 212(6))", async () => {
    const script = (request: { role: string; cwd: string }) => {
      writeFile(request.cwd, ".vtc/research/repo-map/map.md", "# map\n");
      return {
        kind: "done" as const,
        session_ref: null,
        output: {
          summary: "done",
          role: request.role,
          exit: "done" as const,
          artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
        },
        model: "sonnet",
        tokens: { in: 1, out: 1, cache_r: 0, cache_w: 0 },
        cost_usd: 0.01,
      };
    };
    const DAEMON = { host: null };
    for (const dispatch of ["headless_allowed", "plugin_only"] as const) {
      const h = createHarness({
        project: { merge_level: 1, hosts: { dispatch } },
        headless: script,
      });
      await h.engine.startAutomatic(REQUEST, ISSUE, DAEMON);
      if (dispatch === "headless_allowed") {
        // the engine runs DISCOVER itself, with no Lead's next call
        expect(h.launched.map((l) => l.request.role)).toEqual(["repo_cartographer"]);
        expect(
          events(h)
            .filter((e) => e.type === "role.dispatched")
            .map((e) => [e.role, e.data.dispatch]),
        ).toEqual([["repo_cartographer", "headless"]]);
      } else {
        expect(h.launched).toEqual([]);
        expect(events(h).filter((e) => e.type === "role.dispatched")).toEqual([]);
      }
      // stop the unattended run here; the rest of it is the usual flow
      await h.engine.pause({});
      await h.release();
    }
  });
});
