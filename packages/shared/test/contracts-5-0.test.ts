/**
 * Contracts 5.0.0 (round 4: automatic issues and PRs, spine AD-27 and §5 readings 184–209). MAJOR
 * for the run-keyed hidden-test layout (D-ck); the rest is additive.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_KINDS_BY_TARGET,
  AUTO_LABELS,
  AUTOMATIC_RUN_MAX_MERGE_LEVEL,
  AUTOMATION_LIMITS,
  AutomationReportSchema,
  autoBranchName,
  autoKindLabel,
  autoPushRefAllowed,
  automationFor,
  autoTemplateAssetPath,
  CODEX_HOST_WEB_SEARCH,
  CONTRACT_SCHEMAS,
  CONTRACTS_VERSION,
  DEFAULT_UPSTREAM_REPO,
  effectiveMergeLevel,
  ENGINE_HTTP,
  EVENT_PAYLOAD_SCHEMAS,
  EVIDENCE_HOSTING_DEFAULT,
  EvidenceManifestSchema,
  GateRunRequestSchema,
  HIDDEN_TESTS,
  hiddenTestsDir,
  hiddenTestsRef,
  HOST_WEB_OFF_NOTICE,
  HostBillingSchema,
  hostWebRoute,
  LOOKBACK_LIMITS,
  NextResultSchema,
  parseAutoMarker,
  planDispatch,
  ProjectConfigSchema,
  PROVIDER_BILLING_NOTICE,
  renderAutoMarker,
  replayGraderFor,
  ReplayResultSchema,
  UpstreamReportSchema,
  UserConfigSchema,
  VERDICT_GRADED_ROLES,
  VisualConfigSchema,
  type AutomationContext,
} from "../src/index.js";
import { COMMIT, NOW, SHA } from "./fixtures.js";

const FP = "0123456789abcdef";

describe("contracts 5.0.0", () => {
  it("is MAJOR over 4.12.0", () => {
    expect(CONTRACTS_VERSION).toBe("5.0.0");
  });
});

describe("hidden acceptance tests keyed by run (D-ck)", () => {
  const request = (hidden_tasks: string[]) => ({
    run: "R-1",
    task: "T-1",
    reason: "round",
    scope: "affected",
    base: COMMIT,
    head: COMMIT,
    checkout: ".vtc/state/checkouts/c1",
    include_hidden: true,
    hidden_tasks,
  });
  it("builds hidden/<repo-key>/<run>/<task>", () => {
    expect(HIDDEN_TESTS.homeDir).toBe("hidden");
    expect(hiddenTestsDir("0123456789abcdef", "R-1", "T-3")).toBe(
      "hidden/0123456789abcdef/R-1/T-3",
    );
    expect(() => hiddenTestsDir("not-a-key", "R-1", "T-3")).toThrow();
    expect(() => hiddenTestsDir("0123456789abcdef", "../x", "T-3")).toThrow();
    expect(() => hiddenTestsDir("0123456789abcdef", "R-1", "x")).toThrow();
  });
  it("resolves a bare task to the request's run and a qualified one to its own run", () => {
    expect(hiddenTestsRef("R-2", "T-4")).toEqual({ run: "R-2", task: "T-4" });
    expect(hiddenTestsRef("R-2", "R-1:T-4")).toEqual({ run: "R-1", task: "T-4" });
    expect(() => hiddenTestsRef("R-2", "../R-1:T-4")).toThrow();
  });
  it("a request may name another run's task, once", () => {
    expect(GateRunRequestSchema.parse(request(["R-0:T-1", "T-2"])).hidden_tasks).toEqual([
      "R-0:T-1",
      "T-2",
    ]);
    expect(GateRunRequestSchema.safeParse(request(["T-2", "R-1:T-2"])).success).toBe(false);
    expect(GateRunRequestSchema.safeParse(request(["R-1/x:T-2"])).success).toBe(false);
  });
});

describe("HostBilling provider (D-ci)", () => {
  it("adds provider with a neutral notice", () => {
    expect(HostBillingSchema.options).toEqual(["subscription", "api_key", "provider"]);
    expect(PROVIDER_BILLING_NOTICE).toBe("billed through your cloud provider or gateway");
  });
});

describe("host web routing (D-cf)", () => {
  it("never names live search for Codex", () => {
    expect(CODEX_HOST_WEB_SEARCH).toBe("cached");
  });
  it("prefers Claude Code, then a safe Lead host, else no host web with a notice", () => {
    const safe = { dispatchable: true, safeHostWeb: true };
    const unsafe = { dispatchable: true, safeHostWeb: false };
    expect(hostWebRoute("codex", { "claude-code": safe, codex: safe })).toEqual({
      host: "claude-code",
      hostWeb: true,
    });
    expect(hostWebRoute("codex", { codex: safe })).toEqual({ host: "codex", hostWeb: true });
    expect(
      hostWebRoute("codex", {
        "claude-code": { dispatchable: false, safeHostWeb: true },
        codex: unsafe,
      }),
    ).toEqual({ host: "codex", hostWeb: false, notice: HOST_WEB_OFF_NOTICE });
  });
});

describe("replays (D-cg, D-ch)", () => {
  it("every lookback_replay trial is an engine-launched headless run, without headless_allowed", () => {
    for (const lead of ["claude-code", "codex"] as const) {
      expect(
        planDispatch("lookback_replay", "plugin_only", { subagents: true, headless: true }, lead),
      ).toBe("headless");
      expect(
        planDispatch("lookback_replay", "plugin_only", { subagents: true, headless: false }, lead),
      ).toBe("unavailable");
    }
    expect(
      planDispatch("role", "plugin_only", { subagents: true, headless: true }, "claude-code"),
    ).toBe("subagent");
  });
  it("caps trials per RETRO and grades verdict roles by their recorded outcome", () => {
    expect(LOOKBACK_LIMITS.maxTrialsPerRetro).toBeGreaterThan(0);
    expect(VERDICT_GRADED_ROLES).toEqual(["spec_verifier"]);
    expect(replayGraderFor("engineer", true)).toBe("gates");
    expect(replayGraderFor("spec_verifier", false)).toBe("verdict");
    expect(replayGraderFor("architect", false)).toBeNull();
    expect(ReplayResultSchema.shape.grader.unwrap().options).toEqual(["gates", "verdict"]);
  });
});

describe("automatic issues and PRs (AD-27)", () => {
  it("splits kinds by target", () => {
    expect(AUTO_KINDS_BY_TARGET.upstream).toContain("lookback");
    expect(AUTO_KINDS_BY_TARGET.project).toContain("parked");
    expect(
      AUTO_KINDS_BY_TARGET.upstream.filter((k) => AUTO_KINDS_BY_TARGET.project.includes(k)),
    ).toEqual([]);
    expect(DEFAULT_UPSTREAM_REPO).toBe("bason-labs/bs-vtc");
  });
  it("names branches vtc/auto/<kind>/<fp8> and pushes nowhere else (D-bw)", () => {
    expect(autoBranchName("lookback", FP)).toBe("vtc/auto/lookback/01234567");
    expect(() => autoBranchName("lookback", "xyz")).toThrow();
    expect(autoPushRefAllowed("refs/heads/vtc/auto/lookback/01234567")).toBe(true);
    expect(autoPushRefAllowed("refs/heads/vtc-evidence")).toBe(true);
    for (const ref of [
      "refs/heads/main",
      "refs/heads/vtc/auto/lookback/0123456",
      "refs/heads/vtc/auto/nope/01234567",
      "refs/heads/vtc/auto/lookback/01234567/x",
      "refs/tags/v1",
      "main",
    ])
      expect(autoPushRefAllowed(ref), ref).toBe(false);
  });
  it("round-trips the hidden marker and ignores a malformed one", () => {
    const marker = { v: 1, kind: "cost", fp: FP, role: "engineer" } as const;
    const text = renderAutoMarker(marker);
    expect(text).toBe("<!-- vtc:auto v=1 kind=cost fp=0123456789abcdef role=engineer -->");
    expect(parseAutoMarker(`intro\n${text}\nbody`)).toEqual(marker);
    expect(parseAutoMarker("<!-- vtc:auto v=1 kind=nope fp=0123456789abcdef -->")).toBeNull();
    expect(parseAutoMarker("no marker")).toBeNull();
  });
  it("labels every item vtc:auto plus its kind (D-bx)", () => {
    expect(AUTO_LABELS.auto).toBe("vtc:auto");
    expect(autoKindLabel("security")).toBe("vtc:kind/security");
    expect(AUTOMATION_LIMITS).toMatchObject({
      newIssuesPerDay: 5,
      openPrsPerKind: 3,
      openLookbackPrsPerRole: 1,
      autoCloseQuietDays: 14,
    });
  });
  it("an upstream report carries VTC-side data only (D-by)", () => {
    const report = {
      v: 1,
      kind: "defect",
      fingerprint: FP,
      vtc_version: "0.4.0",
      role: "engineer",
      host: "codex",
      error_class: "adapter.parse_failure",
      vtc_frames: ["adapters/src/codex/parse.ts:parseEvents"],
      metrics: { "tokens.per_task": 1200 },
      occurrences: 3,
      first_seen: NOW,
      last_seen: NOW,
    };
    expect(UpstreamReportSchema.parse(report).vtc_frames).toHaveLength(1);
    for (const leak of [
      { ...report, repo: "acme/app" },
      { ...report, title: "Fix the login page" },
      { ...report, vtc_frames: ["/Users/me/acme/src/x.ts:f"] },
      { ...report, vtc_frames: ["engine/src/../../x.ts:f"] },
      { ...report, vtc_frames: ["app/src/x.ts:f"] },
      { ...report, metrics: { path: "src/x.ts" } },
      { ...report, kind: "parked" },
    ])
      expect(UpstreamReportSchema.safeParse(leak).success).toBe(false);
  });
  it("an evidence manifest has at least one redaction-passed file within the budget (D-ce)", () => {
    const manifest = {
      v: 1,
      kind: "lookback",
      fingerprint: FP,
      hosting: EVIDENCE_HOSTING_DEFAULT,
      files: [
        {
          name: "01-replay.webm",
          kind: "replay_video",
          bytes: 1000,
          sha256: SHA,
          redaction: "passed",
          alt: "replay",
        },
      ],
      complete: false,
      captured_at: NOW,
    };
    expect(EVIDENCE_HOSTING_DEFAULT).toBe("branch");
    expect(EvidenceManifestSchema.parse(manifest).files).toHaveLength(1);
    expect(EvidenceManifestSchema.safeParse({ ...manifest, files: [] }).success).toBe(false);
    expect(
      EvidenceManifestSchema.safeParse({
        ...manifest,
        files: [{ ...manifest.files[0], name: "/Users/me/shot.png" }],
      }).success,
    ).toBe(false);
  });
  it("ships the templates in the plugin", () => {
    expect(autoTemplateAssetPath("auto-pr")).toBe("vtc/templates/auto-pr.md");
  });
  it("logs every automatic action (D-ca) and serves the Automation view", () => {
    const opened = EVENT_PAYLOAD_SCHEMAS["upstream.pr_opened"].parse({
      target: { kind: "upstream", repo: DEFAULT_UPSTREAM_REPO },
      kind: "lookback",
      fingerprint: FP,
      number: 12,
      url: "https://github.com/bason-labs/bs-vtc/pull/12",
      branch: "vtc/auto/lookback/01234567",
      evidence: "complete",
    });
    expect(opened.number).toBe(12);
    expect(
      EVENT_PAYLOAD_SCHEMAS["automation.skipped"].parse({ reason: "paused", detail: "vtc pause" })
        .reason,
    ).toBe("paused");
    expect(ENGINE_HTTP.routes.automation.response).toBe("AutomationReport");
    expect(Object.hasOwn(CONTRACT_SCHEMAS, "AutomationReport")).toBe(true);
    expect(
      AutomationReportSchema.parse({
        issues: false,
        prs: false,
        upstream: true,
        upstream_repo: DEFAULT_UPSTREAM_REPO,
        evidence_hosting: "branch",
        notes: ["automatic issues and PRs are off: this project has no GitHub remote"],
        items: [],
        skipped: [],
      }).items,
    ).toEqual([]);
    expect(
      NextResultSchema.parse({ run: "R-1", actions: [], notices: ["2 issues opened"] }).notices,
    ).toHaveLength(1);
  });
  it("marks an automatic run, which never runs at Level 3 (D-bw, D-cd)", () => {
    const started = EVENT_PAYLOAD_SCHEMAS["run.started"].shape.automation.unwrap();
    expect(
      started.parse({
        kind: "parked",
        fingerprint: FP,
        target: { kind: "project", repo: "acme/app" },
        issue: 7,
      }).issue,
    ).toBe(7);
    expect(AUTOMATIC_RUN_MAX_MERGE_LEVEL).toBe(2);
    expect(effectiveMergeLevel(3, [])).toBe(3);
    expect(effectiveMergeLevel(3, [], { automatic: true })).toBe(2);
    expect(effectiveMergeLevel(3, [{ kind: "restore", cap: 3 }], { automatic: true })).toBe(2);
    expect(effectiveMergeLevel(1, [], { automatic: true })).toBe(1);
  });
});

describe("automation settings (D-bz, D-by)", () => {
  const on: AutomationContext = { githubRemote: true, ghLoggedIn: true, paused: false };
  const project = ProjectConfigSchema.parse({ version: 1 });
  const user = UserConfigSchema.parse({ version: 1 });
  it("is on by default with a GitHub remote and a gh login", () => {
    expect(automationFor(project, user, on)).toMatchObject({
      issues: true,
      prs: true,
      upstream: true,
      upstreamRepo: DEFAULT_UPSTREAM_REPO,
      evidenceHosting: "branch",
      notes: [],
    });
  });
  it("is off with a visible note without a remote or a login, and when paused", () => {
    const noRemote = automationFor(project, user, { ...on, githubRemote: false });
    expect([noRemote.issues, noRemote.prs, noRemote.upstream]).toEqual([false, false, true]);
    expect(noRemote.notes).toHaveLength(1);
    const paused = automationFor(project, user, { ...on, paused: true });
    expect([paused.issues, paused.prs, paused.upstream]).toEqual([false, false, false]);
  });
  it("honours both opt-outs and the project switches", () => {
    const optedOut = ProjectConfigSchema.parse({
      version: 1,
      upstream: { share: false },
      automation: { prs: false },
    });
    const settings = automationFor(optedOut, user, on);
    expect([settings.issues, settings.prs, settings.upstream]).toEqual([true, false, false]);
    const userOff = UserConfigSchema.parse({ version: 1, upstream: { share: false } });
    expect(automationFor(project, userOff, on).upstream).toBe(false);
    expect(
      UserConfigSchema.safeParse({ version: 1, upstream: { checkout: "relative/path" } }).success,
    ).toBe(false);
    expect(
      ProjectConfigSchema.safeParse({ version: 1, automation: { evidence: { max_mb: 50 } } })
        .success,
    ).toBe(false);
  });
  it("lets gates.yml name the app's own redacted regions", () => {
    expect(
      VisualConfigSchema.parse({ redact_selectors: ["[data-secret]"] }).redact_selectors,
    ).toEqual(["[data-secret]"]);
  });
});
