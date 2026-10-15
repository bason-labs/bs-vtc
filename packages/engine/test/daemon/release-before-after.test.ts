/**
 * D-ct through the daemon (spine §5 readings 223 and 231): an automatic run's release names the
 * commit its branch was cut from (`AutomaticRelease.base`), the bridge hands it to the upstream
 * module as the PR source's `base`, and a UI PR comes out `evidence: complete` with the gate
 * runner's before, after and changed-flow files. The real bridge and upstream module over
 * in-memory GitHub and plumbing (D-cc: no real gh).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  automationFor,
  type AutomationContext,
  type AutomationDeps,
  type BeforeAfterRequest,
  type BeforeAfterResult,
} from "@vtc/shared";
import type { AutomaticRelease, EventDraft } from "../../src/core/index.js";
import { automaticPrInput, bridgeUpstream } from "../../src/daemon/upstream-bridge.js";
import { createUpstream } from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { fakeAssets, fakePlumbing, fakeRecorder, memoryGitHub } from "../upstream/fakes.js";

afterEach(cleanupDirs);

const HEAD = "7".repeat(40);
/** The cut point; the default branch has moved on to `TIP` since. */
const CUT = "5".repeat(40);
const TIP = "1".repeat(40);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBM = (() => {
  const bytes = new Uint8Array(500).fill(1);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
})();

const RELEASE: AutomaticRelease = {
  run: "r1",
  feature: "F-1",
  automation: {
    kind: "finding",
    fingerprint: "0123456789abcdef",
    target: { kind: "project", repo: "acme/app" },
    issue: 42,
  },
  head: HEAD,
  base: CUT,
  title: "Fix the export button contrast",
  request: "Fix the export button contrast (#42)",
  tasks: [{ id: "T-1", title: "Raise the button contrast", risk_tags: [] }],
  specVerifier: "pass",
  steps: [{ step: 3, status: "pass" }],
  change: "ui",
  startedAt: "2026-10-15T09:00:00.000Z",
  at: "2026-10-15T10:00:00.000Z",
};

const wire = () => {
  const plumbing = fakePlumbing({ "refs/remotes/origin/main": TIP });
  const github = memoryGitHub({ remote: plumbing.remote });
  const requests: BeforeAfterRequest[] = [];
  const recorder = {
    ...fakeRecorder(),
    captureBeforeAfter: (request: BeforeAfterRequest): Promise<BeforeAfterResult> => {
      requests.push(request);
      const files: BeforeAfterResult["files"][number][] = [];
      const write = (name: string, kind: "ui_before" | "ui_after" | "flow_video"): void => {
        const bytes = kind === "flow_video" ? WEBM : PNG;
        writeFileSync(join(request.outDir, name), bytes);
        files.push({ name, kind, bytes: bytes.length });
      };
      write("01-ui-before-home.png", "ui_before");
      write("02-ui-after-home.png", "ui_after");
      if (request.flowSeconds !== undefined) write("03-changed-flow.webm", "flow_video");
      return Promise.resolve({ files, failed: [] });
    },
  };
  const automation: AutomationDeps = {
    issues: github.issues,
    pullRequests: github.pullRequests,
    evidence: recorder,
    plumbing: () => plumbing,
    upstream: { repo: "bason-labs/bs-vtc", share: true },
    hosting: "attach",
    ffmpeg: false,
  };
  const context: AutomationContext = { githubRemote: true, ghLoggedIn: true, paused: false };
  const emitted: EventDraft[] = [];
  const guardDir = tempDir("vtc-guard-");
  const wiring = bridgeUpstream(
    // the real module; only its gh fallbacks are pinned, so no real gh can run (D-cc)
    (deps) =>
      createUpstream({
        ...deps,
        ghCommand: join(guardDir, "no-gh"),
        defaultBranch: () => Promise.resolve("main"),
      }),
    {
      guardDir,
      vtcVersion: "0.5.0",
      assets: fakeAssets(),
      remoteUrl: "git@github.com:acme/app.git",
      clientNames: () => [],
      knownValues: () => [],
      redactSelectors: () => undefined,
      projectEvidence: () => undefined,
      lookbackPr: () => Promise.resolve("none"),
      evidenceSnapshot: () => ({ routes: {}, events: [] }),
      gitOps: () => ({ readFileAtCommit: () => Promise.resolve(undefined) }),
      remoteRefs: () => ({
        fetch: () => Promise.resolve(),
        message: () => Promise.resolve(null),
      }),
      plumbing: () => plumbing,
    },
  )({
    projectRoot: tempDir("acme-app-"),
    vtcHome: tempDir("vtc-home-"),
    automation,
    settings: () => automationFor({}, { upstream: { repo: "bason-labs/bs-vtc" } }, context),
    context: () => context,
    emit: (draft) => {
      emitted.push(draft);
    },
    startRun: () => Promise.resolve(),
    now: () => new Date("2026-10-15T10:00:00.000Z"),
  });
  return { wiring, github, requests, emitted };
};

describe("an automatic UI run's PR through the daemon (D-ct)", () => {
  it("passes the release's cut point as the PR source's base", () => {
    expect(automaticPrInput(RELEASE, { routes: {}, events: [] }, "0.5.0").source).toEqual({
      pushedHead: HEAD,
      base: CUT,
    });
    const { base: _cut, ...unrecorded } = RELEASE;
    expect(automaticPrInput(unrecorded, { routes: {}, events: [] }, "0.5.0").source).toEqual({
      pushedHead: HEAD,
    });
  });

  it("comes out evidence: complete with ui_before, ui_after and flow_video, the before side at the cut point", async () => {
    const { wiring, github, requests, emitted } = wire();
    await wiring.onAutomaticRelease?.(RELEASE);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ base: CUT, head: HEAD });
    const opened = emitted.find((e) => e.type === "upstream.pr_opened");
    expect(opened?.data).toMatchObject({ evidence: "complete", issue: 42 });
    expect(opened?.data).not.toHaveProperty("partial_reason");
    const [pr] = github.state.prs;
    expect(pr?.labels).not.toContain("evidence: partial");
    expect(pr?.attached.filter((n) => /ui-|changed-flow/.test(n))).toEqual([
      expect.stringMatching(/ui-before-home\.png$/),
      expect.stringMatching(/ui-after-home\.png$/),
      expect.stringMatching(/changed-flow\.webm$/),
    ]);
  });
});
