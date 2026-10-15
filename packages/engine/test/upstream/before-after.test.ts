/**
 * UI before/after evidence of an automatic run's PR (D-ct; spine §5 reading 223): at its release
 * the gate runner renders the base and the head (`EvidenceRecorder.captureBeforeAfter`), and the
 * PR comes out `complete`, or `evidence: partial` with the reason on the manifest and on
 * `upstream.pr_opened`.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_LIMITS,
  EvidenceManifestSchema,
  LOOKBACK_REPO,
  routingConfigSubject,
  type BeforeAfterRequest,
  type BeforeAfterResult,
  type EvidenceRecorder,
  type RoutingScorecard,
} from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactRouteKey,
  EVIDENCE_READY,
  manifestDir,
  type AutoPrInput,
  type UpstreamEvent,
} from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { fakeRecorder, type FakeRecorder } from "./fakes.js";
import { BASE_SHA, harness } from "./harness.js";

afterEach(cleanupDirs);

const HEAD = "7".repeat(40);
/** The commit the run's branch was cut from; the default branch has since moved to `BASE_SHA`. */
const CUT = "5".repeat(40);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** A WebM: the EBML header, then anything. */
const WEBM = (() => {
  const bytes = new Uint8Array(500).fill(1);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
})();

interface BeforeAfterRecorder extends FakeRecorder {
  readonly beforeAfter: BeforeAfterRequest[];
}

/** A recorder whose gate runner renders both commits (or reports `partial`). */
const uiRecorder = (
  options: {
    partial?: BeforeAfterResult["partial"];
    /** Extra files the recorder claims: a symlink, a wrong kind, a text file named .png. */
    planted?: (outDir: string) => BeforeAfterResult["files"];
  } = {},
): BeforeAfterRecorder => {
  const inner = fakeRecorder();
  const beforeAfter: BeforeAfterRequest[] = [];
  return {
    ...inner,
    beforeAfter,
    captureBeforeAfter: (request) => {
      beforeAfter.push(request);
      const files: BeforeAfterResult["files"][number][] = [];
      const write = (name: string, kind: "ui_before" | "ui_after" | "flow_video"): void => {
        const bytes = kind === "flow_video" ? WEBM : PNG;
        writeFileSync(join(request.outDir, name), bytes);
        files.push({ name, kind, bytes: bytes.length });
      };
      if (options.partial?.reason !== "base_build_failed")
        write("01-ui-before-home.png", "ui_before");
      write("02-ui-after-home.png", "ui_after");
      if (request.flowSeconds !== undefined) write("03-changed-flow.webm", "flow_video");
      files.push(...(options.planted?.(request.outDir) ?? []));
      return Promise.resolve({
        files,
        failed: [],
        ...(options.partial === undefined ? {} : { partial: options.partial }),
      });
    },
  };
};

const releaseInput = (over: Partial<AutoPrInput> = {}): AutoPrInput => ({
  target: "project",
  kind: "finding",
  fingerprint: "0123456789abcdef",
  summary: "fix the export button contrast",
  slots: { summary: "Fixes the contrast." },
  source: { pushedHead: HEAD, base: CUT },
  issue: 1,
  specVerifier: "pass",
  evidence: {
    plan: { run: "R7", upstreamSafe: false, change: "ui" },
    snapshot: { routes: {}, events: [] },
  },
  ...over,
});

const opened = (events: readonly UpstreamEvent[]) =>
  events.find((e) => e.type === "upstream.pr_opened")?.payload;

const manifest = (repoRoot: string, fp = "0123456789abcdef") =>
  EvidenceManifestSchema.parse(
    JSON.parse(
      readFileSync(join(manifestDir({ kind: "project", repoRoot }, fp), "manifest.json"), "utf8"),
    ),
  );

describe("an automatic run's UI PR (D-ct)", () => {
  it("comes out complete with the gate runner's before, after and changed flow", async () => {
    const recorder = uiRecorder();
    const h = harness({ automation: { evidence: recorder, hosting: "attach" } });
    expect(await h.upstream.openPullRequest(releaseInput(), h.ctx)).toMatchObject({
      status: "pr",
      evidence: "complete",
      ready: true,
    });
    expect(recorder.beforeAfter).toHaveLength(1);
    const request = recorder.beforeAfter[0];
    expect(request).toMatchObject({
      repoRoot: h.ctx.repoRoot,
      base: CUT,
      head: HEAD,
      flowSeconds: EVIDENCE_LIMITS.maxFlowSeconds,
    });
    expect(request?.redactSelectors).toContain("[data-vtc-redact]");
    expect(request?.denyText).toContain("sk-live-payroll-SECRET-1234");
    const pr = h.github.state.prs[0];
    expect(pr?.labels).not.toContain("evidence: partial");
    expect(pr?.attached.filter((n) => /ui-|changed-flow/.test(n))).toEqual([
      "03-ui-before-home.png",
      "04-ui-after-home.png",
      "05-changed-flow.webm",
    ]);
    // the recorder renders no changed-flow steps yet (spine §5 reading 233): its video says what
    // it shows, the first screen loading and then idle, never "the changed flow"
    expect(pr?.body).toContain("First rendered screen, loading then idle");
    expect(pr?.body).not.toContain("The changed flow");
    expect(opened(h.events)).toMatchObject({ evidence: "complete" });
    expect(opened(h.events)).not.toHaveProperty("partial_reason");
    const kept = manifest(h.ctx.repoRoot);
    expect(kept.complete).toBe(true);
    expect(kept.partial_reason).toBeUndefined();
    expect(kept.files.map((f) => f.kind)).toEqual([
      "replay_video",
      "screenshot",
      "ui_before",
      "ui_after",
      "flow_video",
    ]);
  });

  it("stays partial with base_build_failed when the base does not build", async () => {
    const recorder = uiRecorder({
      partial: { reason: "base_build_failed", detail: "install failed in the gate sandbox" },
    });
    const h = harness({ automation: { evidence: recorder, hosting: "attach" } });
    expect(await h.upstream.openPullRequest(releaseInput(), h.ctx)).toMatchObject({
      status: "pr",
      evidence: "partial",
    });
    const pr = h.github.state.prs[0];
    expect(pr?.labels).toContain("evidence: partial");
    expect(pr?.body).toContain("the base commit did not build in the gate sandbox");
    expect(opened(h.events)).toMatchObject({
      evidence: "partial",
      partial_reason: "base_build_failed",
    });
    expect(manifest(h.ctx.repoRoot)).toMatchObject({
      complete: false,
      partial_reason: "base_build_failed",
    });
  });

  it("renders the cut point as the before, not the default branch that moved on since", async () => {
    const recorder = uiRecorder();
    const h = harness({ automation: { evidence: recorder, hosting: "attach" } });
    // the default branch moved past the cut point after the run branched
    expect(h.plumbing.refs.get("refs/remotes/origin/main")).toBe(BASE_SHA);
    await h.upstream.openPullRequest(releaseInput(), h.ctx);
    expect(recorder.beforeAfter.map((r) => r.base)).toEqual([CUT]);
  });

  it("is partial (capture_failed) when the recorder cannot render the base, or the cut point is unknown", async () => {
    const old = harness({ automation: { evidence: fakeRecorder(), hosting: "attach" } });
    await old.upstream.openPullRequest(releaseInput(), old.ctx);
    expect(opened(old.events)).toMatchObject({
      evidence: "partial",
      partial_reason: "capture_failed",
    });
    // no recorded cut point: nothing is built, and the reason does not claim a failed build
    const recorder = uiRecorder();
    const unknown = harness({ automation: { evidence: recorder, hosting: "attach" } });
    await unknown.upstream.openPullRequest(
      releaseInput({ source: { pushedHead: HEAD } }),
      unknown.ctx,
    );
    expect(recorder.beforeAfter).toEqual([]);
    expect(opened(unknown.events)).toMatchObject({
      evidence: "partial",
      partial_reason: "capture_failed",
    });
    expect(unknown.github.state.prs[0]?.body).not.toContain("did not build");
  });

  it("asks for no flow video when the project turned recordings off: video_off", async () => {
    const recorder = uiRecorder();
    const h = harness({
      automation: { evidence: recorder, hosting: "attach" },
      evidence: { video: false },
    });
    await h.upstream.openPullRequest(releaseInput(), h.ctx);
    expect(recorder.beforeAfter[0]).not.toHaveProperty("flowSeconds");
    expect(opened(h.events)).toMatchObject({ evidence: "partial", partial_reason: "video_off" });
  });

  it("is partial with no_ffmpeg under branch hosting without ffmpeg", async () => {
    const recorder = uiRecorder();
    const h = harness({ automation: { evidence: recorder, hosting: "branch", ffmpeg: false } });
    await h.upstream.openPullRequest(releaseInput(), h.ctx);
    expect(opened(h.events)).toMatchObject({ evidence: "partial", partial_reason: "no_ffmpeg" });
  });

  it("never publishes a planted symlink, a wrong kind, a non-PNG or a non-video the recorder names", async () => {
    const secret = join(tempDir("vtc-outside-"), "id_ed25519");
    writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----");
    const recorder = uiRecorder({
      planted: (outDir) => {
        symlinkSync(secret, join(outDir, "04-ui-before-x.png"));
        writeFileSync(join(outDir, "05-ui-after-y.png"), "not a png");
        writeFileSync(join(outDir, "06-chart.png"), PNG);
        writeFileSync(join(outDir, "07-flow-x.webm"), "#!/bin/sh not a video");
        writeFileSync(join(outDir, "08-flow-y.mp4"), WEBM);
        mkdirSync(join(outDir, "sub"));
        return [
          { name: "04-ui-before-x.png", kind: "ui_before", bytes: 10 },
          { name: "05-ui-after-y.png", kind: "ui_after", bytes: 9 },
          { name: "06-chart.png", kind: "chart", bytes: PNG.length },
          { name: "07-flow-x.webm", kind: "flow_video", bytes: 21 },
          { name: "08-flow-y.mp4", kind: "flow_video", bytes: WEBM.length },
          { name: "../../etc/passwd", kind: "ui_after", bytes: 1 },
        ];
      },
    });
    const h = harness({ automation: { evidence: recorder, hosting: "attach" } });
    expect(await h.upstream.openPullRequest(releaseInput(), h.ctx)).toMatchObject({
      status: "pr",
      evidence: "complete",
    });
    const kinds = manifest(h.ctx.repoRoot).files.map((f) => f.kind);
    expect(kinds.filter((k) => k === "ui_before" || k === "ui_after")).toHaveLength(2);
    expect(kinds.filter((k) => k === "flow_video")).toHaveLength(1);
    expect(kinds).not.toContain("chart");
  });

  it("records no before/after for a branch it built itself or a non-UI release", async () => {
    const recorder = uiRecorder();
    const h = harness({ automation: { evidence: recorder, hosting: "attach" } });
    await h.upstream.openPullRequest(
      releaseInput({
        evidence: {
          plan: { run: "R7", upstreamSafe: false, change: "non_ui" },
          snapshot: { routes: {}, events: [] },
          gateReport: {} as never,
        },
      }),
      h.ctx,
    );
    await h.upstream.openPullRequest(
      releaseInput({
        fingerprint: "fedcba9876543210",
        source: {
          changes: [{ path: "src/a.tsx", bytes: new TextEncoder().encode("x") }],
          message: "fix",
        },
      }),
      h.ctx,
    );
    expect(recorder.beforeAfter).toEqual([]);
  });
});

const ROUTING_CARD: RoutingScorecard = {
  v: 1,
  grader_bundle_sha: "c".repeat(64),
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" },
  cells: [
    {
      role: "engineer",
      host: "claude-code",
      size: "M",
      risk: "tagged",
      start_tier: "mid",
      start_reason: "rule",
      tasks: 14,
      metrics: {},
      escalated: { value: 0.64, ci_low: 0.39, ci_high: 0.84, n: 14 },
      cost_per_task_usd: { value: null, ci_low: null, ci_high: null, n: 14 },
    },
  ],
  written_at: "2026-10-14T00:00:00.000Z",
};

describe("a routing-table PR's evidence (D-cn)", () => {
  it("charts the routing scorecard of the run's checkout from the Lookback view", async () => {
    const served: number[] = [];
    const inner = fakeRecorder();
    const recorder: EvidenceRecorder & { shots: string[] } = {
      shots: [],
      renderGateReport: (r) => inner.renderGateReport(r),
      capture: async (request) => {
        recorder.shots.push(...request.shots.map((s) => s.waitFor ?? ""));
        const url = new URL(artifactRouteKey("R7", LOOKBACK_REPO.routingScorecard), request.origin);
        served.push((await fetch(url)).status);
        return inner.capture(request);
      },
    };
    const h = harness({ automation: { evidence: recorder, hosting: "attach" }, self: true });
    const card = join(h.checkout, LOOKBACK_REPO.routingScorecard);
    mkdirSync(join(card, ".."), { recursive: true });
    writeFileSync(card, JSON.stringify(ROUTING_CARD));
    await h.upstream.report(
      {
        type: "improvement",
        kind: "config",
        subject: routingConfigSubject("engineer", "M", "tagged"),
        metrics: { "routing.tasks": 14 },
        at: "2026-10-15T11:00:00Z",
      },
      h.ctx,
    );
    const issue = h.github.state.issues[0];
    expect(issue?.marker?.kind).toBe("config");
    const outcome = await h.upstream.openPullRequest(
      {
        target: "upstream",
        kind: "config",
        fingerprint: issue?.marker?.fp ?? "",
        summary: "start engineer M tagged tasks on top",
        slots: { summary: "Routing table change." },
        source: { pushedHead: HEAD },
        issue: issue?.number,
        report: {
          v: 1,
          kind: "config",
          fingerprint: issue?.marker?.fp ?? "",
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
    expect(outcome).toMatchObject({ status: "pr", evidence: "complete" });
    expect(recorder.shots).toContain(EVIDENCE_READY.routing);
    expect(served.every((s) => s === 200)).toBe(true);
    const kinds = h.github.state.prs[0]?.attached ?? [];
    expect(kinds.some((n) => n.includes("chart"))).toBe(true);
  });

  /** Raises the config issue of `subject` on the bs-vtc checkout and opens its run's PR. */
  const configPr = async (subject: string, editBody?: (body: string) => string) => {
    const inner = fakeRecorder();
    const waits: string[] = [];
    const h = harness({
      self: true,
      automation: {
        hosting: "attach",
        evidence: {
          renderGateReport: (r) => inner.renderGateReport(r),
          capture: (r) => {
            waits.push(...r.shots.map((s) => s.waitFor ?? ""));
            return inner.capture(r);
          },
        },
      },
    });
    const card = join(h.checkout, LOOKBACK_REPO.routingScorecard);
    mkdirSync(join(card, ".."), { recursive: true });
    writeFileSync(card, JSON.stringify(ROUTING_CARD));
    await h.upstream.report(
      { type: "improvement", kind: "config", subject, at: "2026-10-15T11:00:00Z" },
      h.ctx,
    );
    if (editBody !== undefined)
      h.github.state.issues = h.github.state.issues.map((i) => ({ ...i, body: editBody(i.body) }));
    const issue = h.github.state.issues[0];
    const fp = issue?.marker?.fp ?? "";
    const outcome = await h.upstream.openPullRequest(
      {
        target: "upstream",
        kind: "config",
        fingerprint: fp,
        summary: "change a VTC default",
        slots: { summary: "Config change." },
        source: { pushedHead: HEAD },
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
    return { h, outcome, waits };
  };

  it("leaves the chart out, partial, when the scorecard holds no cell of the issue", async () => {
    // the card holds engineer M tagged only
    const { h, outcome, waits } = await configPr(routingConfigSubject("engineer", "S", "none"));
    expect(outcome).toMatchObject({ status: "pr", evidence: "partial" });
    expect(waits).not.toContain(EVIDENCE_READY.routing);
    expect(opened(h.events)).toMatchObject({
      evidence: "partial",
      partial_reason: "capture_failed",
    });
  });

  it("takes no routing cell an edited issue body names that its fingerprint does not", async () => {
    const { outcome, waits } = await configPr(
      "caps.fix_rounds",
      (body) => `${body}\nRouting cell: \`routing.engineer.M.tagged\`\n`,
    );
    expect(outcome).toMatchObject({ status: "pr", evidence: "complete" });
    expect(waits).not.toContain(EVIDENCE_READY.routing);
  });

  it("reads no routing scorecard through a symlinked directory of the checkout", async () => {
    const elsewhere = tempDir("vtc-elsewhere-");
    const inner = fakeRecorder();
    const waits: string[] = [];
    const h = harness({
      self: true,
      automation: {
        hosting: "attach",
        evidence: {
          renderGateReport: (r) => inner.renderGateReport(r),
          capture: (r) => {
            waits.push(...r.shots.map((s) => s.waitFor ?? ""));
            return inner.capture(r);
          },
        },
      },
    });
    // `.vtc/lookback` points outside the checkout, where a card with the cell sits
    const rel = LOOKBACK_REPO.routingScorecard.split("/");
    mkdirSync(join(elsewhere, ...rel.slice(2, -1)), { recursive: true });
    writeFileSync(join(elsewhere, ...rel.slice(2)), JSON.stringify(ROUTING_CARD));
    mkdirSync(join(h.checkout, rel[0] ?? ""), { recursive: true });
    symlinkSync(elsewhere, join(h.checkout, rel[0] ?? "", rel[1] ?? ""));
    await h.upstream.report(
      {
        type: "improvement",
        kind: "config",
        subject: routingConfigSubject("engineer", "M", "tagged"),
        at: "2026-10-15T11:00:00Z",
      },
      h.ctx,
    );
    const issue = h.github.state.issues[0];
    const fp = issue?.marker?.fp ?? "";
    expect(
      await h.upstream.openPullRequest(
        {
          target: "upstream",
          kind: "config",
          fingerprint: fp,
          summary: "start engineer M tagged tasks on top",
          slots: { summary: "Routing table change." },
          source: { pushedHead: HEAD },
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
      ),
    ).toMatchObject({ status: "pr", evidence: "partial" });
    expect(waits).not.toContain(EVIDENCE_READY.routing);
  });

  it("a config PR of a cap or budget issue charts nothing extra", async () => {
    const inner = fakeRecorder();
    const waits: string[] = [];
    const h = harness({
      self: true,
      automation: {
        hosting: "attach",
        evidence: {
          renderGateReport: (r) => inner.renderGateReport(r),
          capture: (r) => {
            waits.push(...r.shots.map((s) => s.waitFor ?? ""));
            return inner.capture(r);
          },
        },
      },
    });
    await h.upstream.report(
      {
        type: "improvement",
        kind: "config",
        subject: "caps.fix_rounds",
        at: "2026-10-15T11:00:00Z",
      },
      h.ctx,
    );
    const issue = h.github.state.issues[0];
    const fp = issue?.marker?.fp ?? "";
    expect(
      await h.upstream.openPullRequest(
        {
          target: "upstream",
          kind: "config",
          fingerprint: fp,
          summary: "raise the fix-round cap",
          slots: { summary: "Cap change." },
          source: { pushedHead: HEAD },
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
      ),
    ).toMatchObject({ status: "pr", evidence: "complete" });
    expect(waits.length).toBeGreaterThan(0);
    expect(waits).not.toContain(EVIDENCE_READY.routing);
  });
});
