/**
 * UI before/after evidence of an automatic run's PR (D-ct; spine §5 reading 223): at its release
 * the gate runner renders the base and the head (`EvidenceRecorder.captureBeforeAfter`), and the
 * PR comes out `complete`, or `evidence: partial` with the reason on the manifest and on
 * `upstream.pr_opened`.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESIGN_FLOWS_PATH,
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
  BEFORE_AFTER_FLOW_ALT,
  changedFlow,
  EVIDENCE_READY,
  FLOWS_FILE_MAX_BYTES,
  flowVideoAlt,
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
    /** One flow video per side, named `-before` / `-after`, as a scripting gate runner writes. */
    sides?: boolean;
    /** What each side's video shows when the request names a flow (contracts 5.7.0). */
    flow?: (request: BeforeAfterRequest) => BeforeAfterResult["flow"];
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
      if (request.flowSeconds !== undefined && options.sides === true) {
        write("03-flow-before.webm", "flow_video");
        write("04-flow-after.webm", "flow_video");
      } else if (request.flowSeconds !== undefined) write("03-changed-flow.webm", "flow_video");
      files.push(...(options.planted?.(request.outDir) ?? []));
      const flow = options.flow?.(request);
      return Promise.resolve({
        files,
        failed: [],
        ...(options.partial === undefined ? {} : { partial: options.partial }),
        ...(flow === undefined ? {} : { flow }),
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
  it("comes out complete with the gate runner's before, after and first-screen recording", async () => {
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
    // no flows file names a flow for this change (reading 247(7)): its video says what it shows,
    // the first screen loading and then idle, never "the changed flow"
    expect(request).not.toHaveProperty("flow");
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

/** A flows file (`.vtc/design/flows.yaml`) with two flows; `checkout` exercises `src/cart/**`. */
const FLOWS_YAML = [
  "version: 1",
  "fixtures:",
  "  coupon: SPRING10",
  "flows:",
  "  - id: sign-in",
  "    start: /login",
  "    screens: [login]",
  "    steps:",
  '      - { action: click, selector: "role=button[name=Sign in]" }',
  "  - id: checkout",
  "    start: /cart",
  "    screens: [cart]",
  '    paths: ["src/cart/**"]',
  "    steps:",
  '      - { action: fill, selector: "#coupon", fixture: coupon }',
  "      - { action: press, key: Enter }",
  '      - { action: wait_for, selector: "[data-testid=total]" }',
  "",
].join("\n");

describe("choosing and captioning the changed flow (pure)", () => {
  const read = (text: string | undefined) => () =>
    Promise.resolve(text === undefined ? undefined : new TextEncoder().encode(text));
  const paths = (list: readonly string[]) => () => Promise.resolve(list);

  it("takes a path match first, then a touched screen, in file order", async () => {
    expect(
      await changedFlow({
        readFlowsFile: read(FLOWS_YAML),
        changedPaths: paths(["src/cart/a.ts"]),
      }),
    ).toBe("checkout");
    expect(
      await changedFlow({
        readFlowsFile: read(FLOWS_YAML),
        changedPaths: paths(["README.md"]),
        screens: ["cart", "login"],
      }),
    ).toBe("sign-in");
    expect(
      await changedFlow({ readFlowsFile: read(FLOWS_YAML), changedPaths: paths(["README.md"]) }),
    ).toBeUndefined();
  });

  it("reads a newer MINOR's flows file, dropping the keys it does not know", async () => {
    const newer = FLOWS_YAML.replace("  - id: checkout", "  - id: checkout\n    owner: designer");
    expect(
      await changedFlow({ readFlowsFile: read(newer), changedPaths: paths(["src/cart/a.ts"]) }),
    ).toBe("checkout");
  });

  it("refuses an oversized flows file", async () => {
    const big = `${FLOWS_YAML}#${"x".repeat(FLOWS_FILE_MAX_BYTES)}\n`;
    expect(
      await changedFlow({ readFlowsFile: read(big), changedPaths: paths(["src/cart/a.ts"]) }),
    ).toBeUndefined();
  });

  it("captions a side by what the gate runner reports for the requested flow", () => {
    const flow = { id: "checkout", before: "scripted", after: "idle" } as const;
    expect(flowVideoAlt("checkout", flow, "before")).toBe(
      'The changed flow "checkout", scripted (before)',
    );
    expect(flowVideoAlt("checkout", flow, "after")).toBe(
      'First rendered screen, loading then idle: this side has no flow "checkout" (after)',
    );
    // a video of no known side: one caption only when both sides agree
    expect(flowVideoAlt("checkout", flow, undefined)).toBe(BEFORE_AFTER_FLOW_ALT);
    expect(
      flowVideoAlt("checkout", { id: "checkout", before: "failed", after: "failed" }, undefined),
    ).toBe('The changed flow "checkout" up to the step that failed');
    // no flow asked for, or a report of another flow: the first-screen caption
    expect(flowVideoAlt(undefined, flow, "before")).toBe(`${BEFORE_AFTER_FLOW_ALT} (before)`);
    expect(flowVideoAlt("sign-in", flow, "before")).toBe(`${BEFORE_AFTER_FLOW_ALT} (before)`);
    expect(flowVideoAlt("checkout", undefined, "after")).toBe(`${BEFORE_AFTER_FLOW_ALT} (after)`);
    expect(BEFORE_AFTER_FLOW_ALT).toMatch(/^First rendered screen, loading then idle/);
  });
});

describe("the scripted flow of an automatic UI PR (D-ct; reading 247(7))", () => {
  const withFlows = (
    recorder: BeforeAfterRecorder,
    options: { flows?: string; changed?: readonly string[] } = {},
  ) => {
    const h = harness({ automation: { evidence: recorder, hosting: "attach" } });
    if (options.flows !== undefined)
      h.filesAt.set(HEAD, new Map([[DESIGN_FLOWS_PATH, options.flows]]));
    h.plumbing.changed.set(HEAD, options.changed ?? ["src/cart/Total.tsx"]);
    return h;
  };
  const scripted = (request: BeforeAfterRequest): BeforeAfterResult["flow"] =>
    request.flow === undefined
      ? undefined
      : { id: request.flow, before: "scripted", after: "scripted" };

  it("picks the head's flow whose globs match a path the change touches, and captions it", async () => {
    const recorder = uiRecorder({ sides: true, flow: scripted });
    const h = withFlows(recorder, { flows: FLOWS_YAML });
    expect(await h.upstream.openPullRequest(releaseInput(), h.ctx)).toMatchObject({
      status: "pr",
      evidence: "complete",
    });
    expect(recorder.beforeAfter[0]?.flow).toBe("checkout");
    // the changed paths are the head's against the cut point, as git lists them
    expect(h.plumbing.diffs).toEqual([[CUT, HEAD]]);
    const body = h.github.state.prs[0]?.body ?? "";
    expect(body).toContain('The changed flow "checkout", scripted (before)');
    expect(body).toContain('The changed flow "checkout", scripted (after)');
    expect(body).not.toContain("First rendered screen");
    const alts = manifest(h.ctx.repoRoot)
      .files.filter((f) => f.kind === "flow_video")
      .map((f) => f.alt);
    expect(alts).toEqual([
      'The changed flow "checkout", scripted (before)',
      'The changed flow "checkout", scripted (after)',
    ]);
  });

  it("picks the flow that passes a touched screen when no flow's globs match", async () => {
    const recorder = uiRecorder({ sides: true, flow: scripted });
    const h = withFlows(recorder, { flows: FLOWS_YAML, changed: ["src/auth/Form.tsx"] });
    await h.upstream.openPullRequest(
      releaseInput({ source: { pushedHead: HEAD, base: CUT, screens: ["login"] } }),
      h.ctx,
    );
    expect(recorder.beforeAfter[0]).toMatchObject({ flow: "sign-in", screens: ["login"] });
  });

  it("captions each side as the gate runner reports it: idle or failed", async () => {
    const recorder = uiRecorder({
      sides: true,
      flow: (request) => ({ id: request.flow ?? "", before: "idle", after: "failed" }),
    });
    const h = withFlows(recorder, { flows: FLOWS_YAML });
    await h.upstream.openPullRequest(releaseInput(), h.ctx);
    const body = h.github.state.prs[0]?.body ?? "";
    expect(body).toContain(
      'First rendered screen, loading then idle: this side has no flow "checkout" (before)',
    );
    expect(body).toContain('The changed flow "checkout" up to the step that failed (after)');
  });

  it("keeps the first-screen caption when the recorder does not say what it scripted", async () => {
    const recorder = uiRecorder({ sides: true });
    const h = withFlows(recorder, { flows: FLOWS_YAML });
    await h.upstream.openPullRequest(releaseInput(), h.ctx);
    expect(recorder.beforeAfter[0]?.flow).toBe("checkout");
    expect(h.github.state.prs[0]?.body).toContain("First rendered screen, loading then idle");
    expect(h.github.state.prs[0]?.body).not.toContain("The changed flow");
  });

  it("names no flow when none matches, or the flows file is missing or invalid", async () => {
    for (const [label, options] of [
      ["no match", { flows: FLOWS_YAML, changed: ["src/settings/Profile.tsx"] }],
      ["missing", {}],
      ["not yaml", { flows: "flows: [\n  - id: x\n" }],
      ["not the schema", { flows: "version: 1\nflows:\n  - id: x\n    start: /\n" }],
      [
        "an unknown fixture",
        {
          flows: FLOWS_YAML.replace("fixture: coupon", "fixture: password"),
        },
      ],
    ] as const) {
      const recorder = uiRecorder({ sides: true, flow: scripted });
      const h = withFlows(recorder, options);
      await h.upstream.openPullRequest(releaseInput(), h.ctx);
      expect(recorder.beforeAfter[0], label).not.toHaveProperty("flow");
      expect(h.github.state.prs[0]?.body, label).toContain(
        "First rendered screen, loading then idle",
      );
    }
  });

  it("names no flow when the head cannot be read or diffed", async () => {
    const recorder = uiRecorder({ sides: true, flow: scripted });
    const h = harness({ automation: { evidence: recorder, hosting: "attach" }, noGitOps: true });
    h.plumbing.changed.set(HEAD, ["src/cart/Total.tsx"]);
    expect(await h.upstream.openPullRequest(releaseInput(), h.ctx)).toMatchObject({
      status: "pr",
    });
    expect(recorder.beforeAfter[0]).not.toHaveProperty("flow");
    const failing = uiRecorder({ sides: true, flow: scripted });
    const g = withFlows(failing, { flows: FLOWS_YAML });
    (g.plumbing as { changedPaths?: unknown }).changedPaths = () =>
      Promise.reject(new Error("git failed"));
    await g.upstream.openPullRequest(releaseInput(), g.ctx);
    expect(failing.beforeAfter[0]).not.toHaveProperty("flow");
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
