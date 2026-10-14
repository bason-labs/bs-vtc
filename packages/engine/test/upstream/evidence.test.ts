/** The evidence pipeline of AD-27 rule 6 (D-ce, H-8) with a fake recorder, plumbing and ffmpeg. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { EvidenceManifestSchema, EVIDENCE_LIMITS } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyEvidenceBudget,
  AutomationSkip,
  gifArgs,
  makeGif,
  planEvidenceShots,
  prepareEvidence,
  publishToEvidenceBranch,
  renderEvidenceSection,
  replayIntervalMs,
  startSnapshotServer,
  type EvidenceRequest,
  type FfmpegCommand,
} from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { fakeAssets, fakePlumbing, fakeRecorder } from "./fakes.js";

afterEach(cleanupDirs);

const FP = "0123456789abcdef";

const get = (
  origin: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; type: string }> =>
  new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString("utf8");
          if (res.headers["content-type"] === "text/event-stream" && body.includes("data:")) {
            res.destroy();
            resolve({ status: res.statusCode ?? 0, body, type: "text/event-stream" });
          }
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body, type: String(res.headers["content-type"]) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

describe("the snapshot server", () => {
  it("serves redacted routes, the replayed events and the dashboard export on the loopback", async () => {
    const server = await startSnapshotServer({
      assets: fakeAssets({
        "index.html": "<html>flow studio</html>",
        "run/index.html": "<html>run</html>",
      }),
      routes: { "/api/runs/R1/status": { token: "known-secret-value-1", ok: true } },
      events: [{ run: "R1", seq: 1, type: "run.started", note: "known-secret-value-1" }],
      replayMs: 5,
      knownValues: ["known-secret-value-1"],
      files: { "gate-report.html": new TextEncoder().encode("<html>gate</html>") },
    });
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const status = await get(server.origin, "/api/runs/R1/status");
      expect(status.status).toBe(200);
      expect(status.body).not.toContain("known-secret-value-1");
      expect(JSON.parse(status.body)).toMatchObject({ ok: true });
      const sse = await get(server.origin, "/api/stream");
      expect(sse.body).toContain("id: R1:1");
      expect(sse.body).not.toContain("known-secret-value-1");
      expect((await get(server.origin, "/run/?run=R1&evidence=1")).body).toBe("<html>run</html>");
      expect((await get(server.origin, "/evidence/gate-report.html")).body).toContain("gate");
      expect((await get(server.origin, "/api/live")).status).toBe(404);
      const host = new URL(server.origin).host;
      expect((await get(server.origin, "/", { host: "evil.example" })).status).toBe(403);
      expect((await get(server.origin, "/", { host, origin: "http://evil.example" })).status).toBe(
        403,
      );
    } finally {
      await server.close();
    }
  });
  it("compresses the replay to fit", () => {
    expect(replayIntervalMs(10)).toBe(600);
    expect(replayIntervalMs(100)).toBe(250);
    expect(replayIntervalMs(10_000)).toBe(40);
  });
});

describe("what to record", () => {
  it("records the replay and a screenshot for every PR, plus per change class", () => {
    const kinds = (input: Parameters<typeof planEvidenceShots>[0]): string[] =>
      planEvidenceShots(input).map((s) => s.kind);
    expect(kinds({ run: "R1", upstreamSafe: false, change: "non_ui" })).toEqual([
      "replay_video",
      "screenshot",
      "gate_report",
    ]);
    expect(
      kinds({ run: "R1", upstreamSafe: false, change: "ui", flowPath: "/task/?run=R1&task=T-1" }),
    ).toEqual(["replay_video", "screenshot", "flow_video"]);
    expect(kinds({ upstreamSafe: true, change: "prompt" })).toEqual([
      "replay_video",
      "screenshot",
      "chart",
      "chart",
    ]);
    const flow = planEvidenceShots({
      run: "R1",
      upstreamSafe: false,
      change: "ui",
      flowPath: "/x",
    })[2];
    expect(flow?.videoSeconds).toBeLessThanOrEqual(EVIDENCE_LIMITS.maxFlowSeconds);
    const upstream = planEvidenceShots({
      run: "R1",
      upstreamSafe: true,
      change: "ui",
      flowPath: "/x",
    });
    expect(upstream.every((s) => s.path.startsWith("/lookback/?evidence=upstream"))).toBe(true);
    expect(upstream.map((s) => s.name)).toEqual(["01-replay.webm", "02-final-state.png"]);
  });
  it("drops every recording when a project turns video off (screenshots only)", () => {
    const shots = planEvidenceShots({
      run: "R1",
      upstreamSafe: false,
      change: "ui",
      flowPath: "/x",
      video: false,
    });
    expect(shots.map((s) => s.name)).toEqual(["01-final-state.png"]);
    expect(shots.every((s) => s.videoSeconds === undefined)).toBe(true);
  });
});

describe("the GIF", () => {
  it("uses the fixed two-pass argv and steps down until it fits", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "01-replay.webm"), "v");
    const calls: string[][] = [];
    let size = 7 * 1024 * 1024;
    const ffmpeg: FfmpegCommand = (args, cwd) => {
      calls.push([...args]);
      expect(cwd).toBe(dir);
      const out = args.at(-1) ?? "";
      if (out.endsWith(".gif")) {
        writeFileSync(join(cwd, out), Buffer.alloc(size));
        size -= 2 * 1024 * 1024;
      } else {
        writeFileSync(join(cwd, out), "p");
      }
      return Promise.resolve(0);
    };
    const bytes = await makeGif({
      ffmpeg,
      dir,
      video: "01-replay.webm",
      output: "03-replay-preview.gif",
    });
    expect(bytes).toBe(5 * 1024 * 1024);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.join(" ")).toContain("palettegen=max_colors=128:stats_mode=diff");
    expect(calls[1]?.join(" ")).toContain("paletteuse=dither=bayer");
    expect(calls[2]).toEqual([
      ...gifArgs("01-replay.webm", "03-replay-preview.gif", { fps: 6, width: 960, seconds: 12 })[0],
    ]);
    expect(existsSync(join(dir, "palette.png"))).toBe(false);
  });
  it("gives up after the last step and removes the GIF", async () => {
    const dir = tempDir();
    const ffmpeg: FfmpegCommand = (args, cwd) => {
      writeFileSync(join(cwd, args.at(-1) ?? "x"), Buffer.alloc(6 * 1024 * 1024));
      return Promise.resolve(0);
    };
    expect(
      await makeGif({ ffmpeg, dir, video: "01-replay.webm", output: "03-replay.gif" }),
    ).toBeNull();
    expect(existsSync(join(dir, "03-replay.gif"))).toBe(false);
    expect(
      await makeGif({
        ffmpeg: () => Promise.resolve(1),
        dir,
        video: "01-replay.webm",
        output: "03-replay.gif",
      }),
    ).toBeNull();
  });
});

describe("the budget", () => {
  it("drops files over their cap and keeps the PR within 10 MB and 12 files, motion first", () => {
    const MB = 1024 * 1024;
    const { kept, dropped } = applyEvidenceBudget([
      { name: "01-replay.webm", kind: "replay_video", bytes: 7 * MB, alt: "a" },
      { name: "02-final-state.png", kind: "screenshot", bytes: 2 * MB, alt: "a" },
      { name: "03-chart-2.png", kind: "chart", bytes: 1 * MB, alt: "a" },
      { name: "04-chart-3.png", kind: "chart", bytes: 1 * MB, alt: "a" },
      { name: "05-replay.gif", kind: "replay_gif", bytes: 2 * MB, alt: "a" },
      { name: "06-flow.webm", kind: "flow_video", bytes: 9 * MB, alt: "a" },
    ]);
    expect(kept.map((f) => f.name)).toEqual(["01-replay.webm", "03-chart-2.png", "05-replay.gif"]);
    expect(dropped.map((f) => f.name).sort()).toEqual([
      "02-final-state.png",
      "04-chart-3.png",
      "06-flow.webm",
    ]);
    const many = Array.from({ length: 15 }, (_, i) => ({
      name: `${String(i + 10)}-shot.png`,
      kind: "screenshot" as const,
      bytes: 10,
      alt: "a",
    }));
    expect(applyEvidenceBudget(many).kept).toHaveLength(EVIDENCE_LIMITS.maxFilesPerPr);
  });
  it("lowers the per-PR budget to a project's max_mb, never raises it", () => {
    const MB = 1024 * 1024;
    const files = [
      { name: "01-replay.webm", kind: "replay_video" as const, bytes: 3 * MB, alt: "a" },
      { name: "02-final-state.png", kind: "screenshot" as const, bytes: 1 * MB, alt: "a" },
    ];
    expect(applyEvidenceBudget(files, 2 * MB).kept.map((f) => f.name)).toEqual([
      "02-final-state.png",
    ]);
    const big = [
      { name: "01-replay.webm", kind: "replay_video" as const, bytes: 7 * MB, alt: "a" },
      { name: "02-final-state.png", kind: "screenshot" as const, bytes: 2 * MB, alt: "a" },
      { name: "03-chart-2.png", kind: "chart" as const, bytes: 2 * MB, alt: "a" },
    ];
    expect(applyEvidenceBudget(big, 100 * MB).kept.map((f) => f.name)).toEqual(
      applyEvidenceBudget(big).kept.map((f) => f.name),
    );
  });
});

describe("hosting", () => {
  it("commits to the orphan vtc-evidence branch and embeds commit-pinned URLs", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "01-replay.webm"), "v");
    writeFileSync(join(dir, "02-final-state.png"), "p");
    const plumbing = fakePlumbing();
    const files = [
      { name: "01-replay.webm", kind: "replay_video" as const, bytes: 1, alt: "Replay" },
      { name: "02-final-state.png", kind: "screenshot" as const, bytes: 1, alt: "Final" },
    ];
    const urls = await publishToEvidenceBranch({
      plumbing,
      repo: "bason-labs/bs-vtc",
      dir,
      files,
      kind: "lookback",
      fingerprint: FP,
      at: new Date("2026-10-15T09:05:00Z"),
    });
    const [commit] = plumbing.commits;
    expect(commit?.base).toBeNull();
    expect(commit?.parents).toEqual([]);
    expect(commit?.changes.map((c) => c.path)).toEqual([
      "lookback/01234567/20261015-0905/01-replay.webm",
      "lookback/01234567/20261015-0905/02-final-state.png",
    ]);
    expect(plumbing.pushes).toEqual([
      { remote: "origin", sha: commit?.sha, dst: "refs/heads/vtc-evidence" },
    ]);
    expect(urls.get("02-final-state.png")).toBe(
      `https://github.com/bason-labs/bs-vtc/blob/${commit?.sha ?? ""}/lookback/01234567/20261015-0905/02-final-state.png?raw=true`,
    );
    await publishToEvidenceBranch({
      plumbing,
      repo: "bason-labs/bs-vtc",
      dir,
      files,
      kind: "lookback",
      fingerprint: FP,
      at: new Date(),
    });
    expect(plumbing.commits[1]?.parents).toEqual([commit?.sha]);
    const section = renderEvidenceSection({ hosting: "branch", files, urls, partial: true });
    expect(section).toContain("[Replay (WebM video)](https://github.com/bason-labs/bs-vtc/blob/");
    expect(section).toContain("![Final](https://github.com/");
    expect(section).toContain("partial");
  });
  it("builds on the branch as the remote last showed it, not a stale local branch", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "01-replay.webm"), "v");
    const remoteHead = "e".repeat(40);
    const plumbing = fakePlumbing({
      "refs/heads/vtc-evidence": "d".repeat(40),
      "refs/remotes/origin/vtc-evidence": remoteHead,
    });
    plumbing.remote.set("refs/heads/vtc-evidence", remoteHead);
    await publishToEvidenceBranch({
      plumbing,
      repo: "bason-labs/bs-vtc",
      dir,
      files: [{ name: "01-replay.webm", kind: "replay_video", bytes: 1, alt: "Replay" }],
      kind: "defect",
      fingerprint: FP,
      at: new Date("2026-10-15T09:05:00Z"),
    });
    expect(plumbing.commits[0]?.parents).toEqual([remoteHead]);
    expect(plumbing.remote.get("refs/heads/vtc-evidence")).toBe(plumbing.commits[0]?.sha);
    expect(plumbing.refs.get("refs/heads/vtc-evidence")).toBe(plumbing.commits[0]?.sha);
  });
  it("attach hosting references the neutral relative names gh rewrites", () => {
    const section = renderEvidenceSection({
      hosting: "attach",
      files: [{ name: "01-replay.webm", kind: "replay_video", bytes: 1, alt: "Replay" }],
      partial: false,
    });
    expect(section).toBe("![Replay](01-replay.webm)");
  });
});

describe("prepareEvidence", () => {
  const request = (over: Partial<EvidenceRequest> = {}): EvidenceRequest => ({
    kind: "defect",
    fingerprint: FP,
    keep: { kind: "upstream", vtcHome: tempDir() },
    repo: "bason-labs/bs-vtc",
    plan: { run: "R1", upstreamSafe: false, change: "non_ui" },
    snapshot: { routes: {}, events: [] },
    gateReport: {} as never,
    knownValues: ["known-secret-value-1"],
    denylist: ["globex"],
    ...over,
  });

  it("captures, publishes and writes a valid manifest (branch, no ffmpeg → partial)", async () => {
    const staging = tempDir();
    const recorder = fakeRecorder();
    const plumbing = fakePlumbing();
    const req = request();
    const outcome = await prepareEvidence(staging, req, {
      recorder,
      assets: fakeAssets(),
      hosting: "branch",
      ffmpeg: false,
      plumbing,
      now: () => new Date("2026-10-15T09:05:00Z"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.partial).toBe(true);
    expect(outcome.manifest.complete).toBe(false);
    expect(outcome.manifest.files.map((f) => f.kind)).toEqual([
      "replay_video",
      "screenshot",
      "gate_report",
    ]);
    expect(outcome.manifest.files.every((f) => f.url?.includes("?raw=true"))).toBe(true);
    expect(recorder.requests[0]?.denyText).toEqual(["known-secret-value-1", "globex"]);
    expect(recorder.requests[0]?.redactSelectors).toContain("[data-vtc-redact]");
    expect(recorder.requests[0]?.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const kept = join(
      req.keep.kind === "upstream" ? req.keep.vtcHome : "",
      "upstream",
      "evidence",
      "01234567",
      "manifest.json",
    );
    expect(EvidenceManifestSchema.parse(JSON.parse(readFileSync(kept, "utf8")))).toEqual(
      outcome.manifest,
    );
  });

  it("is complete in attach hosting without ffmpeg, and adds a GIF when ffmpeg is present", async () => {
    const attach = await prepareEvidence(tempDir(), request(), {
      recorder: fakeRecorder(),
      assets: fakeAssets(),
      hosting: "attach",
      ffmpeg: false,
      now: () => new Date(),
    });
    expect(attach.ok && !attach.partial && attach.attach.length === 3).toBe(true);
    const ffmpeg: FfmpegCommand = (args, cwd) => {
      writeFileSync(join(cwd, args.at(-1) ?? "x"), "gif");
      return Promise.resolve(0);
    };
    const withGif = await prepareEvidence(tempDir(), request(), {
      recorder: fakeRecorder(),
      assets: fakeAssets(),
      hosting: "branch",
      ffmpeg: true,
      ffmpegCommand: ffmpeg,
      plumbing: fakePlumbing(),
      now: () => new Date(),
    });
    expect(withGif.ok && withGif.manifest.complete).toBe(true);
    expect(withGif.ok ? withGif.manifest.files.map((f) => f.name) : []).toContain(
      "04-replay-preview.gif",
    );
  });

  it("fails the step (for the evidence-failed issue) when the gate report or the push fails", async () => {
    const throwing = { ...fakeRecorder(), renderGateReport: () => Promise.reject(new Error("x")) };
    expect(
      await prepareEvidence(tempDir(), request(), {
        recorder: throwing,
        assets: fakeAssets(),
        hosting: "attach",
        ffmpeg: false,
        now: () => new Date(),
      }),
    ).toEqual({ ok: false, detail: expect.stringContaining("gate report") as string });
    const plumbing = fakePlumbing();
    plumbing.remote.set("refs/heads/vtc-evidence", "9".repeat(40));
    const refused = await prepareEvidence(tempDir(), request(), {
      recorder: fakeRecorder(),
      assets: fakeAssets(),
      hosting: "branch",
      ffmpeg: false,
      plumbing,
      now: () => new Date(),
    });
    expect(refused).toEqual({
      ok: false,
      detail: expect.stringContaining("could not be pushed") as string,
    });
    expect(plumbing.commits).toHaveLength(2);
  });

  it("checks the opt-outs again right before the evidence branch is pushed", async () => {
    const plumbing = fakePlumbing();
    await expect(
      prepareEvidence(tempDir(), request(), {
        recorder: fakeRecorder(),
        assets: fakeAssets(),
        hosting: "branch",
        ffmpeg: false,
        plumbing,
        now: () => new Date(),
        beforePublish: () => {
          throw new AutomationSkip("share_off", "upstream reports are off");
        },
      }),
    ).rejects.toMatchObject({ reason: "share_off" });
    expect(plumbing.pushes).toHaveLength(0);
  });

  it("never writes the manifest through a symlink a role planted in the project", async () => {
    const repoRoot = tempDir("vtc-project-");
    const victim = join(tempDir("vtc-victim-"), "gitconfig");
    writeFileSync(victim, "[user]\n");
    const dir = join(repoRoot, ".vtc", "evidence", "auto", FP.slice(0, 8));
    mkdirSync(dir, { recursive: true });
    symlinkSync(victim, join(dir, "manifest.json"));
    const outcome = await prepareEvidence(
      tempDir(),
      request({ keep: { kind: "project", repoRoot } }),
      {
        recorder: fakeRecorder(),
        assets: fakeAssets(),
        hosting: "attach",
        ffmpeg: false,
        now: () => new Date(),
      },
    );
    expect(outcome.ok).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("[user]\n");
    expect(lstatSync(join(dir, "manifest.json")).isSymbolicLink()).toBe(false);

    // A symlinked fingerprint directory is refused outright.
    const other = tempDir("vtc-project-");
    const outside = tempDir("vtc-outside-");
    mkdirSync(join(other, ".vtc", "evidence", "auto"), { recursive: true });
    symlinkSync(outside, join(other, ".vtc", "evidence", "auto", FP.slice(0, 8)));
    await expect(
      prepareEvidence(tempDir(), request({ keep: { kind: "project", repoRoot: other } }), {
        recorder: fakeRecorder(),
        assets: fakeAssets(),
        hosting: "attach",
        ffmpeg: false,
        now: () => new Date(),
      }),
    ).rejects.toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("retries failed shots once, then fails with no file", async () => {
    const recorder = fakeRecorder({ failing: (attempt) => attempt === 1 });
    const retried = await prepareEvidence(tempDir(), request(), {
      recorder,
      assets: fakeAssets(),
      hosting: "attach",
      ffmpeg: false,
      now: () => new Date(),
    });
    expect(recorder.requests).toHaveLength(2);
    expect(retried.ok).toBe(true);
    const never = fakeRecorder({ failing: () => true });
    const failed = await prepareEvidence(tempDir(), request(), {
      recorder: never,
      assets: fakeAssets(),
      hosting: "attach",
      ffmpeg: false,
      now: () => new Date(),
    });
    expect(never.requests).toHaveLength(EVIDENCE_LIMITS.captureAttempts);
    expect(failed).toEqual({
      ok: false,
      detail: expect.stringContaining("no evidence file") as string,
    });
  });

  it("copies the visual gate's before/after for UI changes, never for upstream-safe ones", async () => {
    const shots = tempDir();
    writeFileSync(join(shots, "before.png"), "b");
    writeFileSync(join(shots, "after.png"), "a");
    const uiShots = [
      { before: join(shots, "before.png"), after: join(shots, "after.png"), label: "Desktop 1280" },
    ];
    const staging = tempDir();
    const ui = await prepareEvidence(
      staging,
      request({ plan: { run: "R1", upstreamSafe: false, change: "ui", flowPath: "/x" }, uiShots }),
      {
        recorder: fakeRecorder(),
        assets: fakeAssets(),
        hosting: "attach",
        ffmpeg: false,
        now: () => new Date(),
      },
    );
    expect(ui.ok && ui.manifest.complete).toBe(true);
    expect(ui.ok ? ui.manifest.files.map((f) => f.name) : []).toEqual([
      "01-replay.webm",
      "02-final-state.png",
      "03-changed-flow.webm",
      "04-ui-before-desktop-1280.png",
      "05-ui-after-desktop-1280.png",
    ]);
    expect(statSync(join(staging, "04-ui-before-desktop-1280.png")).size).toBe(1);
    const upstream = await prepareEvidence(
      tempDir(),
      request({ plan: { upstreamSafe: true, change: "ui", flowPath: "/x" }, uiShots }),
      {
        recorder: fakeRecorder(),
        assets: fakeAssets(),
        hosting: "attach",
        ffmpeg: false,
        now: () => new Date(),
      },
    );
    expect(upstream.ok ? upstream.manifest.files.map((f) => f.kind) : []).toEqual([
      "replay_video",
      "screenshot",
    ]);
  });
});
