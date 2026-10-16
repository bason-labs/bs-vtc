/**
 * The D-cs and D-cn improvements as VTC's repo reads them (spine §5 readings 219 and 221): a
 * `tool` issue names the command shape and its task count, a `capability` issue the slug and its
 * count (never the reason), and a `config` issue whose subject starts `routing.` is a
 * routing-table change, all through the kind's pattern, the redaction and the denylist.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROUTING_REPLAY_VERDICT_CODES,
  routedStartTier,
  routingConfigSubject,
  upstreamSubjectKey,
  type RoutingTable,
} from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoFingerprint,
  projectSubject,
  readRoutingTableSource,
  ROUTING_TABLE_FILE,
  routingSubjectOfBody,
  writeRoutingTableSource,
  type AutomationFact,
} from "../../src/upstream/index.js";
import { cleanupDirs } from "../helpers/repo.js";
import { BASE_SHA, harness } from "./harness.js";

afterEach(cleanupDirs);

const REPO = join(import.meta.dirname, "../../../..");
/** D-cm's table (reading 218(2)) in the repo's own file: the moves below start from its tiers. */
const DCM: RoutingTable = {
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
};

const improvement = (
  kind: "tool" | "capability" | "config",
  subject: string,
  metrics: Record<string, number> = {},
): AutomationFact => ({
  type: "improvement",
  kind,
  subject,
  metrics,
  at: "2026-10-15T11:00:00Z",
});

describe("the subject patterns (pure)", () => {
  it("takes a command shape key, a slug, a routing cell or a config key, and refuses anything else", () => {
    expect(projectSubject("tool", "git status 1a2b3c4d5e6f")).toMatchObject({
      kind: "tool",
      shape: { program: "git", subcommand: "status", flags: "1a2b3c4d5e6f" },
    });
    expect(projectSubject("tool", "<path> - 1a2b3c4d5e6f")).toMatchObject({
      shape: { program: "<path>", flags: "1a2b3c4d5e6f" },
    });
    expect(projectSubject("capability", "browser-automation")).toEqual({
      kind: "capability",
      slug: "browser-automation",
    });
    expect(projectSubject("config", routingConfigSubject("engineer", "S", "none"))).toMatchObject({
      kind: "routing",
      role: "engineer",
      size: "S",
      risk: "none",
    });
    expect(projectSubject("config", "budget.task_s")).toEqual({
      kind: "config",
      key: "budget.task_s",
    });
    expect(projectSubject("new_agent", "anything at all")).toBeUndefined();
    for (const [kind, subject] of [
      ["tool", 'git commit -m "fix payroll"'],
      ["tool", "git status 1a2b3c4d5e6f /Users/alice/x"],
      ["capability", "needs a browser to log in to the client portal"],
      ["config", "routing.engineer.XL.none"],
      ["config", "routing.Engineer.S.none"],
      ["config", "budget task s"],
      // only VTC's enumerated cap and budget keys, never any dotted key
      ["config", "payroll_portal.export_retries"],
      ["config", "budget.task_xl"],
    ] as const) {
      expect(() => projectSubject(kind, subject), subject).toThrow(/vocabulary/);
    }
  });
});

describe("tool and capability issues (D-cs)", () => {
  it("a tool issue names the shape and its task count, nothing else of the commands", async () => {
    const h = harness();
    const outcome = await h.upstream.report(
      improvement("tool", "pnpm exec 0a1b2c3d4e5f", { "tool.tasks": 4 }),
      h.ctx,
    );
    expect(outcome).toMatchObject({ status: "issue", action: "opened" });
    const issue = h.github.state.issues[0];
    expect(issue?.title).toBe(
      "vtc(tool): promote the recurring command `pnpm exec` to an engine tool",
    );
    expect(issue?.body).toContain(
      "Command shape: `pnpm`, subcommand `exec`, flag set `0a1b2c3d4e5f`",
    );
    expect(issue?.body).toContain("| tool.tasks | 4 |");
  });

  it("a capability issue names the slug and its count, never a reason", async () => {
    const h = harness();
    await h.upstream.report(
      improvement("capability", "browser-automation", { "capability.escalations": 3 }),
      h.ctx,
    );
    const issue = h.github.state.issues[0];
    expect(issue?.title).toBe("vtc(capability): missing capability `browser-automation`");
    expect(issue?.body).toContain("| capability.escalations | 3 |");
    // a reason in place of the slug never leaves
    expect(
      await h.upstream.report(
        improvement("capability", "a browser to log in to the client portal"),
        h.ctx,
      ),
    ).toMatchObject({ status: "skipped", reason: "privacy" });
    expect(h.github.state.issues).toHaveLength(1);
  });

  it("a shape or slug that names the project fails closed on the denylist", async () => {
    const h = harness();
    expect(
      await h.upstream.report(improvement("tool", "globex-export - 0a1b2c3d4e5f"), h.ctx),
    ).toMatchObject({ status: "skipped", reason: "privacy" });
    expect(
      await h.upstream.report(improvement("capability", "payroll-portal-login"), h.ctx),
    ).toMatchObject({ status: "skipped", reason: "privacy" });
    expect(h.github.state.issues).toEqual([]);
  });
});

describe("routing-table changes (D-cn)", () => {
  it("renders a routing config fact as a change of DEFAULT_ROUTING_TABLE's values only", async () => {
    const h = harness();
    const subject = routingConfigSubject("engineer", "M", "tagged");
    await h.upstream.report(
      improvement("config", subject, { "routing.tasks": 14, "routing.escalated_pct": 64 }),
      h.ctx,
    );
    const issue = h.github.state.issues[0];
    expect(issue?.title).toBe("vtc(config): routing: engineer start tier for M tasks, a risk tag");
    expect(issue?.body).toContain(`Routing cell: \`${subject}\``);
    expect(issue?.body).toContain(
      `Change only the values of \`DEFAULT_ROUTING_TABLE\` in \`${ROUTING_TABLE_FILE}\``,
    );
    expect(issue?.body).toContain("`roles.engineer`");
    expect(issue?.body).toContain("| routing.escalated_pct | 64 |");
    expect(issue?.body).toContain("Check the routing scorecard charts");
    const cell = routingSubjectOfBody(issue?.body);
    expect(cell).toEqual({ kind: "routing", role: "engineer", size: "M", risk: "tagged" });
    expect(cell === null ? null : upstreamSubjectKey(cell)).toBe(subject);
    // a cap or budget key stays a plain config change
    await h.upstream.report(improvement("config", "caps.fix_rounds"), h.ctx);
    expect(h.github.state.issues[1]?.title).toBe("vtc(config): config change `caps.fix_rounds`");
    expect(routingSubjectOfBody(h.github.state.issues[1]?.body)).toBeNull();
  });

  const TABLE_SOURCE = writeRoutingTableSource(
    readFileSync(join(REPO, ROUTING_TABLE_FILE), "utf8"),
    DCM,
  );
  const MOVE_TO_TOP = {
    "routing.from_tier": 1,
    "routing.to_tier": 2,
    "routing.current_tier": 1,
    "routing.shared": 0,
    "routing.replay_planned": 0,
  };

  it("answers a routing issue with the module's own one-file PR, never a run (reading 233)", async () => {
    const started: string[] = [];
    const h = harness({
      self: true,
      startRun: (input) => {
        started.push(input.request);
        return Promise.resolve();
      },
    });
    h.files.set(ROUTING_TABLE_FILE, TABLE_SOURCE);
    const subject = routingConfigSubject("engineer", "M", "tagged");
    await h.upstream.report(improvement("config", subject, MOVE_TO_TOP), h.ctx);
    expect(started).toEqual([]);
    expect(h.github.state.prs).toHaveLength(1);
    const pr = h.github.state.prs[0];
    expect(pr?.title).toBe("vtc(config): start engineer M tasks with a risk tag on top");
    expect(pr?.body).toContain("`DEFAULT_ROUTING_TABLE.roles.engineer.tagged_floor`");
    expect(pr?.body).toContain(`#${String(h.github.state.issues[0]?.number)}`);
    // the evidence says what it is: the scorecard, no tier replay yet (reading 233)
    expect(pr?.body).toContain("No tier replay backs this change");
    // no Spec Verifier for a value the module set itself: ready for the human to merge
    expect(pr?.isDraft).toBe(false);
    // one commit, one file: the table with the engineer's own cell moved
    const commit = h.plumbing.commits.at(-1);
    expect(commit?.base).toBe(BASE_SHA);
    expect(commit?.changes.map((c) => c.path)).toEqual([ROUTING_TABLE_FILE]);
    const text = new TextDecoder().decode(commit?.changes[0]?.bytes ?? new Uint8Array());
    const table = readRoutingTableSource(text);
    expect(table.roles).toEqual({ engineer: { tagged_floor: "top" } });
    expect(routedStartTier(table, "engineer", "M", "tagged")).toBe("top");
    expect(routedStartTier(table, "qa", "M", "tagged")).toBe("mid");
    // the scope check ran on the commit's paths and let it through
    expect(h.events.filter((e) => e.type === "automation.skipped")).toEqual([]);
    // seen again while its PR is open: nothing more
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 24 * 3600 * 1000);
    await h.upstream.report(improvement("config", subject, MOVE_TO_TOP), h.ctx);
    expect(h.github.state.prs).toHaveLength(1);
    expect(started).toEqual([]);
  });

  const REPLAYED = {
    ...MOVE_TO_TOP,
    "routing.replay_planned": 1,
    "routing.replay_verdict": ROUTING_REPLAY_VERDICT_CODES.improve,
    "routing.replay_trials": 24,
  };

  it("cites the graded tier replay in the issue and the PR when the fact carries one", async () => {
    const h = harness({ self: true });
    h.files.set(ROUTING_TABLE_FILE, TABLE_SOURCE);
    await h.upstream.report(
      improvement("config", routingConfigSubject("engineer", "M", "tagged"), REPLAYED),
      h.ctx,
    );
    expect(h.github.state.issues[0]?.body).toContain(
      "A graded tier replay backs the move: verdict `improve` over 24 trials.",
    );
    const body = h.github.state.prs[0]?.body ?? "";
    expect(body).toContain(
      "A graded tier replay backs this change: verdict `improve` over 24 trials",
    );
    expect(body).not.toContain("only evidence");
    // the RoutingReplayResult stays on the machine that graded it
    expect(body).not.toMatch(/routing-replays|\.vtc\/lookback/);
  });

  it("pickup cites the replay another installation's routing issue names", async () => {
    const elsewhere = harness({ noGitOps: true });
    await elsewhere.upstream.report(
      improvement("config", routingConfigSubject("engineer", "M", "tagged"), REPLAYED),
      elsewhere.ctx,
    );
    const h = harness({ shared: elsewhere, self: true });
    h.files.set(ROUTING_TABLE_FILE, TABLE_SOURCE);
    await h.upstream.pickup(h.ctx);
    const body = h.github.state.prs[0]?.body ?? "";
    // as the issue's claim, never as a replay VTC ran or checked
    expect(body).toContain(
      "The issue cites a graded tier replay that backs this change: verdict `improve` over 24 trials, as the issue lists it",
    );
    expect(body).not.toContain("A graded tier replay backs this change");
    expect(body).not.toContain("Lookback ran the cell's recorded tasks");
  });

  it("pickup refuses another installation's routing issue whose cited replay does not back the move", async () => {
    const elsewhere = harness({ noGitOps: true });
    await elsewhere.upstream.report(
      improvement("config", routingConfigSubject("engineer", "M", "tagged"), {
        ...REPLAYED,
        "routing.replay_verdict": ROUTING_REPLAY_VERDICT_CODES.no_change,
      }),
      elsewhere.ctx,
    );
    expect(elsewhere.github.state.issues[0]?.body).toContain(
      "A graded tier replay does not back the move",
    );
    const h = harness({ shared: elsewhere, self: true });
    h.files.set(ROUTING_TABLE_FILE, TABLE_SOURCE);
    await h.upstream.pickup(h.ctx);
    expect(h.github.state.prs).toEqual([]);
    expect(h.events.find((e) => e.type === "automation.skipped")?.payload).toMatchObject({
      reason: "out_of_scope",
      kind: "config",
    });
  });

  it("pickup refuses another installation's routing issue of a reviewer cell (D-cu)", async () => {
    const elsewhere = harness({ noGitOps: true });
    const subject = routingConfigSubject("spec_verifier", "M", "tagged");
    await elsewhere.upstream.report(improvement("config", subject, MOVE_TO_TOP), elsewhere.ctx);
    // an older VTC raised it before D-cu: plant its issue as listed
    expect(elsewhere.github.state.issues).toEqual([]);
    const engineer = routingConfigSubject("engineer", "M", "tagged");
    await elsewhere.upstream.report(improvement("config", engineer, MOVE_TO_TOP), elsewhere.ctx);
    const fp = autoFingerprint({ kind: "config", subject });
    elsewhere.github.state.issues = elsewhere.github.state.issues.map((i) => ({
      ...i,
      body: i.body.replaceAll(i.marker?.fp ?? "-", fp).replaceAll("engineer", "spec_verifier"),
      marker: i.marker === null ? null : { ...i.marker, fp },
    }));
    const h = harness({ shared: elsewhere, self: true });
    h.files.set(ROUTING_TABLE_FILE, TABLE_SOURCE);
    await h.upstream.pickup(h.ctx);
    expect(h.github.state.prs).toEqual([]);
    expect(h.events.find((e) => e.type === "automation.skipped")?.payload).toMatchObject({
      reason: "out_of_scope",
    });
  });

  it("refuses a move from a tier the table no longer starts the cell on (stale_baseline)", async () => {
    const h = harness({ self: true });
    h.files.set(ROUTING_TABLE_FILE, TABLE_SOURCE);
    await h.upstream.report(
      improvement("config", routingConfigSubject("engineer", "M", "tagged"), {
        ...MOVE_TO_TOP,
        "routing.from_tier": 0,
      }),
      h.ctx,
    );
    expect(h.github.state.prs).toEqual([]);
    expect(h.events.find((e) => e.type === "automation.skipped")?.payload).toMatchObject({
      reason: "stale_baseline",
    });
  });

  it("pickup answers another installation's routing issue with the PR, asking for no run", async () => {
    // the raising installation has no bs-vtc checkout to edit the table at
    const elsewhere = harness({ noGitOps: true });
    await elsewhere.upstream.report(
      improvement("config", routingConfigSubject("qa", "S", "none"), {
        ...MOVE_TO_TOP,
        "routing.from_tier": 0,
        "routing.to_tier": 1,
        "routing.shared": 1,
      }),
      elsewhere.ctx,
    );
    expect(elsewhere.github.state.issues).toHaveLength(1);
    expect(elsewhere.github.state.prs).toEqual([]);
    const started: string[] = [];
    const h = harness({
      shared: elsewhere,
      self: true,
      startRun: (input) => {
        started.push(input.request);
        return Promise.resolve();
      },
    });
    h.files.set(ROUTING_TABLE_FILE, TABLE_SOURCE);
    expect(await h.upstream.pickup(h.ctx)).toEqual([]);
    expect(started).toEqual([]);
    expect(h.github.state.prs).toHaveLength(1);
    const text = new TextDecoder().decode(
      h.plumbing.commits.at(-1)?.changes[0]?.bytes ?? new Uint8Array(),
    );
    expect(readRoutingTableSource(text).by_size).toEqual({ S: "mid", M: "mid", L: "top" });
    // answered: a second pickup opens nothing more
    await h.upstream.pickup(h.ctx);
    expect(h.github.state.prs).toHaveLength(1);
  });

  /**
   * Raises the routing issue of `subject` on the bs-vtc checkout (no move in its metrics, so the
   * module opens no PR of its own) and opens a run's pushed head for it, as a run started from a
   * routing issue before reading 233 would: the scope check still guards that path.
   */
  const routingPr = async (
    changed: readonly string[],
    options: { base?: string; noDiff?: boolean } = {},
  ) => {
    const h = harness({ self: true });
    const head = "7".repeat(40);
    h.plumbing.changed.set(head, changed);
    if (options.noDiff === true)
      (h.plumbing as { changedPaths?: unknown }).changedPaths = undefined;
    const subject = routingConfigSubject("engineer", "M", "tagged");
    await h.upstream.report(
      improvement("config", subject, { "routing.from_tier": 1, "routing.to_tier": 2 }),
      h.ctx,
    );
    const issue = h.github.state.issues[0];
    const fp = issue?.marker?.fp ?? "";
    const outcome = await h.upstream.openPullRequest(
      {
        target: "upstream",
        kind: "config",
        fingerprint: fp,
        summary: "start engineer M tagged tasks on top",
        slots: { summary: "Routing table change." },
        source: {
          pushedHead: head,
          ...(options.base === undefined ? {} : { base: options.base }),
        },
        issue: issue?.number,
        report: {
          v: 1,
          kind: "config",
          fingerprint: fp,
          vtc_version: "0.4.0",
          vtc_frames: [],
          metrics: {},
          occurrences: 1,
          first_seen: "2026-10-15T11:00:00.000Z",
          last_seen: "2026-10-15T11:00:00.000Z",
        },
        specVerifier: "pass",
        evidence: {
          plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
          snapshot: { routes: {}, events: [] },
          gateReport: {} as never,
        },
      },
      h.ctx,
    );
    return { h, outcome, head };
  };

  it("opens a routing run's PR that changes only the routing table, diffed from the cut point or the default branch", async () => {
    const { h, outcome, head } = await routingPr([ROUTING_TABLE_FILE]);
    expect(outcome).toMatchObject({ status: "pr" });
    expect(h.github.state.prs).toHaveLength(1);
    // no cut point recorded: against the remote default branch's tip
    expect(h.plumbing.diffs).toEqual([[BASE_SHA, head]]);
    const cut = "5".repeat(40);
    const withCut = await routingPr([ROUTING_TABLE_FILE], { base: cut });
    expect(withCut.outcome).toMatchObject({ status: "pr" });
    expect(withCut.h.plumbing.diffs).toEqual([[cut, head]]);
  });

  it("refuses a routing run's PR that touches any other file before it opens (AD-8)", async () => {
    const { h, outcome } = await routingPr([ROUTING_TABLE_FILE, "packages/shared/src/index.ts"]);
    expect(outcome).toMatchObject({ status: "skipped", reason: "out_of_scope" });
    expect(h.github.state.prs).toEqual([]);
    const skipped = h.events.find((e) => e.type === "automation.skipped");
    expect(skipped?.payload).toMatchObject({ reason: "out_of_scope", kind: "config" });
    expect(JSON.stringify(skipped?.payload)).toContain("packages/shared/src/index.ts");
  });

  it("refuses a run's PR of a reviewer's cell (D-cu), by its report's subject or its issue", async () => {
    const subject = routingConfigSubject("spec_verifier", "M", "high");
    const fp = autoFingerprint({ kind: "config", subject });
    const runPr = (h: ReturnType<typeof harness>, withSubject: boolean, issue?: number) =>
      h.upstream.openPullRequest(
        {
          target: "upstream",
          kind: "config",
          fingerprint: fp,
          summary: "start spec_verifier M high-risk tasks on top",
          slots: { summary: "Routing table change." },
          source: { pushedHead: "7".repeat(40) },
          issue,
          report: {
            v: 1,
            kind: "config",
            fingerprint: fp,
            vtc_version: "0.4.0",
            vtc_frames: [],
            metrics: {},
            occurrences: 1,
            first_seen: "2026-10-15T11:00:00.000Z",
            last_seen: "2026-10-15T11:00:00.000Z",
            ...(withSubject
              ? { subject: { kind: "routing", role: "spec_verifier", size: "M", risk: "high" } }
              : {}),
          },
          specVerifier: "pass",
          evidence: {
            plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
            snapshot: { routes: {}, events: [] },
            gateReport: {} as never,
          },
        },
        h.ctx,
      );
    // the report's typed subject is the reviewer's cell
    const bySubject = harness({ self: true });
    bySubject.plumbing.changed.set("7".repeat(40), [ROUTING_TABLE_FILE]);
    expect(await runPr(bySubject, true)).toMatchObject({
      status: "skipped",
      reason: "out_of_scope",
    });
    expect(bySubject.github.state.prs).toEqual([]);
    // no subject on the report: the cell its issue names (an older VTC raised it before D-cu)
    const byIssue = harness({ self: true });
    byIssue.plumbing.changed.set("7".repeat(40), [ROUTING_TABLE_FILE]);
    await byIssue.upstream.report(
      improvement("config", routingConfigSubject("engineer", "M", "high"), {
        "routing.from_tier": 1,
        "routing.to_tier": 2,
      }),
      byIssue.ctx,
    );
    byIssue.github.state.issues = byIssue.github.state.issues.map((i) => ({
      ...i,
      body: i.body.replaceAll(i.marker?.fp ?? "-", fp).replaceAll("engineer", "spec_verifier"),
      marker: i.marker === null ? null : { ...i.marker, fp },
    }));
    const planted = byIssue.github.state.issues[0];
    expect(routingSubjectOfBody(planted?.body)).toMatchObject({ role: "spec_verifier" });
    expect(await runPr(byIssue, false, planted?.number)).toMatchObject({
      status: "skipped",
      reason: "out_of_scope",
    });
    expect(byIssue.github.state.prs).toEqual([]);
  });

  it("fails closed when the plumbing cannot list the changed paths", async () => {
    const { h, outcome } = await routingPr([ROUTING_TABLE_FILE], { noDiff: true });
    expect(outcome).toMatchObject({ status: "skipped", reason: "out_of_scope" });
    expect(h.github.state.prs).toEqual([]);
  });

  it("names the tier the cell moves to, from the routing fact's metrics", async () => {
    const h = harness();
    await h.upstream.report(
      improvement("config", routingConfigSubject("engineer", "M", "tagged"), {
        "routing.from_tier": 1,
        "routing.to_tier": 2,
        "routing.current_tier": 1,
        "routing.shared": 0,
        "routing.replay_planned": 0,
      }),
      h.ctx,
    );
    const body = h.github.state.issues[0]?.body ?? "";
    expect(body).toContain("Move the start tier from `mid` to `top`");
    expect(body).toContain("`roles.engineer`");
    // a rank outside the tiers renders no tier name
    const other = harness();
    await other.upstream.report(
      improvement("config", routingConfigSubject("engineer", "M", "tagged"), {
        "routing.from_tier": 1,
        "routing.to_tier": 7,
      }),
      other.ctx,
    );
    expect(other.github.state.issues[0]?.body).not.toContain("Move the start tier");
  });
});
