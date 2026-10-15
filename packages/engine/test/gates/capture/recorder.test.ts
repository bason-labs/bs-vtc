/**
 * The evidence recorder (AD-27 rule 6, D-ce) with a fake runner: request checks, the browser
 * store, the selectors it paints and masks, the scan's verdicts, the budget, and reasons that
 * never carry the matched text. No browser, no network.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BrowserPinSchema,
  EVIDENCE_LIMITS,
  SECRET_PATTERNS,
  type EvidenceCaptureRequest,
  type EvidenceShot,
} from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  cleanReason,
  createEvidenceRecorder,
  EVIDENCE_NO_BROWSER,
  EVIDENCE_PAINT_DEFAULTS,
  EvidenceRunnerResultSchema,
  type EvidenceRunner,
  type EvidenceRunnerCall,
  type EvidenceRunnerResult,
} from "../../../src/gates/capture/index.js";
import type { VisualToolchain } from "../../../src/gates/visual/index.js";
import { tempDir } from "../../helpers/repo.js";
import { config, testsGate } from "../fixture.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const WEBM = Buffer.from("1a45dfa3", "hex");

const pin = BrowserPinSchema.parse({
  v: 1,
  source: "vtc",
  name: "chromium",
  version: "140.0.1",
  playwright_core_version: "1.59.0",
  executable: "/store/chromium/chrome",
  executable_sha256: "a".repeat(64),
  installed_at: "2026-10-01T00:00:00.000Z",
});

const toolchain: VisualToolchain = {
  source: "vtc",
  playwright: "/store/node_modules/playwright-core/index.mjs",
  playwrightVersion: "1.59.0",
  axe: null,
  pixelmatch: null,
  browsersPath: "/store",
  readable: ["/store"],
};

const shot = (name: string, extra: Partial<EvidenceShot> = {}): EvidenceShot => ({
  name,
  kind: name.endsWith(".webm") ? "replay_video" : "screenshot",
  path: "/runs/R1?evidence=upstream",
  viewport: { width: 1280, height: 800 },
  ...extra,
});

/** A runner that answers per shot name from `answers`, recording the call. */
const fakeRunner = (
  answers: Record<string, Partial<EvidenceRunnerResult["shots"][number]> & { bytes?: Buffer }>,
  overrides: Partial<EvidenceRunnerResult> = {},
): { runner: EvidenceRunner; calls: EvidenceRunnerCall[] } => {
  const calls: EvidenceRunnerCall[] = [];
  return {
    calls,
    runner: {
      run: (call) => {
        calls.push(call);
        const bytes = new Map<string, Buffer>();
        const shots = call.input.shots.map((s) => {
          const a = answers[s.name] ?? {};
          const status = a.status ?? "captured";
          if (status === "captured")
            bytes.set(s.name, a.bytes ?? (s.name.endsWith(".png") ? PNG : WEBM));
          return {
            name: s.name,
            status,
            ...(a.detail === undefined ? {} : { detail: a.detail }),
            hits: a.hits ?? [],
            ...(status === "captured" ? { file: s.name } : {}),
          };
        });
        const result = EvidenceRunnerResultSchema.parse({
          v: 1,
          browser: { name: "chromium", version: "140.0.1" },
          shots,
          files: Object.fromEntries([...bytes.keys()].map((k) => [k, "0".repeat(64)])),
          ...overrides,
        });
        return Promise.resolve({
          ok: true,
          result,
          file: (name: string) => bytes.get(name) ?? null,
        });
      },
    },
  };
};

const setup = (
  runner: EvidenceRunner,
  options: { gatesYml?: string; store?: boolean; check?: "ok" | "mismatch" } = {},
) => {
  const home = tempDir("vtc-evidence-home-");
  const repo = tempDir("vtc-evidence-repo-");
  if (options.gatesYml !== undefined) {
    mkdirSync(join(repo, ".vtc"), { recursive: true });
    writeFileSync(join(repo, ".vtc/gates.yml"), options.gatesYml);
  }
  const recorder = createEvidenceRecorder(
    { vtcHome: home, repoRoot: repo },
    {
      runner,
      toolchain: () => (options.store === false ? null : toolchain),
      checkBrowser: () =>
        Promise.resolve(
          options.check === "mismatch"
            ? {
                ok: false as const,
                reason: "the browser /store/chromium/chrome does not match its pin",
              }
            : { ok: true as const, pin },
        ),
    },
  );
  const outDir = join(tempDir("vtc-evidence-out-"), "staging");
  const request = (extra: Partial<EvidenceCaptureRequest> = {}): EvidenceCaptureRequest => ({
    origin: "http://127.0.0.1:41234",
    outDir,
    shots: [shot("01-replay.webm", { videoSeconds: 12 }), shot("02-gates.png")],
    redactSelectors: [".prompt-text"],
    denyText: [],
    ...extra,
  });
  return { recorder, outDir, request, repo };
};

const GATES_YML = config([testsGate], {
  visual: { dynamic_regions: [".clock"], redact_selectors: ["[data-customer]"] },
});

describe("the evidence recorder (AD-27 rule 6)", () => {
  it("captures through the runner and writes each file into outDir", async () => {
    const { runner, calls } = fakeRunner({});
    const { recorder, outDir, request } = setup(runner);
    const result = await recorder.capture(request());
    expect(result.failed).toEqual([]);
    expect(result.files).toEqual([
      { name: "01-replay.webm", kind: "replay_video", bytes: WEBM.length },
      { name: "02-gates.png", kind: "screenshot", bytes: PNG.length },
    ]);
    expect(readFileSync(join(outDir, "02-gates.png"))).toEqual(PNG);
    expect(statSync(join(outDir, "02-gates.png")).mode & 0o777).toBe(0o600);
    const input = calls[0]?.input;
    expect(input).toMatchObject({
      origin: "http://127.0.0.1:41234",
      executable: pin.executable,
      playwright: toolchain.playwright,
      video_size: { width: 1280, height: 800 },
      mask_color: "#1f1f1f",
      relay: false,
    });
    expect(input?.shots).toEqual([
      {
        name: "01-replay.webm",
        path: "/runs/R1?evidence=upstream",
        width: 1280,
        height: 800,
        video_seconds: 12,
      },
      { name: "02-gates.png", path: "/runs/R1?evidence=upstream", width: 1280, height: 800 },
    ]);
    // The scan's patterns are the shared redaction's, by source.
    expect(input?.patterns.map((p) => p.kind)).toEqual(SECRET_PATTERNS.map((p) => p.kind));
    expect(calls[0]?.port).toBe(41234);
    expect(calls[0]?.allowRead).toEqual(["/store"]);
    expect(calls[0]?.env.PLAYWRIGHT_BROWSERS_PATH).toBe("/store");
  });

  it("paints the defaults, the request's selectors and gates.yml redact_selectors; masks dynamic_regions too", async () => {
    const { runner, calls } = fakeRunner({});
    const { recorder, request } = setup(runner, { gatesYml: GATES_YML });
    await recorder.capture(request());
    const input = calls[0]?.input;
    expect(input?.paint).toEqual([...EVIDENCE_PAINT_DEFAULTS, ".prompt-text", "[data-customer]"]);
    expect(input?.mask).toEqual([...(input?.paint ?? []), ".clock"]);
    expect(EVIDENCE_PAINT_DEFAULTS).toEqual(
      expect.arrayContaining(["[data-vtc-redact]", "input[type=password]"]),
    );
  });

  it("fails every shot, closed, when gates.yml cannot be read", async () => {
    const { runner, calls } = fakeRunner({});
    const { recorder, request } = setup(runner, { gatesYml: "visual: [unclosed" });
    const result = await recorder.capture(request());
    expect(calls).toHaveLength(0);
    expect(result.files).toEqual([]);
    expect(result.failed.map((f) => f.name)).toEqual(["01-replay.webm", "02-gates.png"]);
    expect(result.failed[0]?.reason).toMatch(/gates\.yml could not be read/);
  });

  it("refuses an origin other than http://127.0.0.1:<port>, running nothing", async () => {
    const { runner, calls } = fakeRunner({});
    const { recorder, request } = setup(runner);
    for (const origin of [
      "http://localhost:41234",
      "https://127.0.0.1:41234",
      "http://127.0.0.1",
      "http://127.0.0.1:41234/path",
      "http://example.com:80",
    ]) {
      const result = await recorder.capture(request({ origin }));
      expect(result.files).toEqual([]);
      expect(result.failed).toHaveLength(2);
      expect(result.failed[0]?.reason).toMatch(/not http:\/\/127\.0\.0\.1:<port>/);
    }
    expect(calls).toHaveLength(0);
  });

  it("fails shots it cannot capture as asked, and captures the rest", async () => {
    const { runner, calls } = fakeRunner({});
    const { recorder, request } = setup(runner);
    const result = await recorder.capture(
      request({
        shots: [
          shot("01-flow.mp4", { kind: "flow_video", videoSeconds: 5 }),
          shot("02-long.webm", { videoSeconds: EVIDENCE_LIMITS.maxReplaySeconds + 1 }),
          shot("03-still.webm", { kind: "screenshot" }),
          shot("Shot.png"),
          shot("04-ok.png"),
          shot("04-ok.png"),
          shot("05-far.png", { path: "//evil.example/x" }),
          shot("06-tiny.png", { viewport: { width: 10, height: 10 } }),
          shot("07-flow.webm", {
            kind: "flow_video",
            videoSeconds: EVIDENCE_LIMITS.maxFlowSeconds + 1,
          }),
          shot("08-flow.webm", {
            kind: "flow_video",
            videoSeconds: EVIDENCE_LIMITS.maxFlowSeconds,
          }),
          shot("09-replay.webm"),
          shot("10-after.png", { kind: "ui_after", videoSeconds: 5 }),
          shot("11-replay.gif", { kind: "replay_gif" }),
        ],
      }),
    );
    expect(result.files.map((f) => f.name)).toEqual(["04-ok.png", "08-flow.webm"]);
    const reasons = new Map(result.failed.map((f) => [f.name, f.reason]));
    expect(reasons.get("01-flow.mp4")).toMatch(/WebM/);
    expect(reasons.get("02-long.webm")).toMatch(/replay_video lasts .* at most 30 seconds/);
    expect(reasons.get("03-still.webm")).toMatch(/PNG/);
    expect(reasons.get("Shot.png")).toMatch(/NN-<slug>/);
    expect(reasons.get("04-ok.png")).toMatch(/used twice/);
    expect(reasons.get("05-far.png")).toMatch(/start with one \//);
    expect(reasons.get("06-tiny.png")).toMatch(/viewport/);
    expect(reasons.get("07-flow.webm")).toMatch(/flow_video lasts .* at most 20 seconds/);
    expect(reasons.get("09-replay.webm")).toMatch(
      /replay_video is a recording: give it videoSeconds/,
    );
    expect(reasons.get("10-after.png")).toMatch(
      /ui_after is a screenshot: it takes no videoSeconds/,
    );
    expect(reasons.get("11-replay.gif")).toMatch(/made from a replay_video later/);
    expect(calls[0]?.input.shots.map((s) => s.name)).toEqual(["04-ok.png", "08-flow.webm"]);
  });

  it("captures nothing without the browser store, or when its pin does not match", async () => {
    const none = fakeRunner({});
    const without = await setup(none.runner, { store: false }).recorder.capture(
      setup(none.runner).request(),
    );
    expect(without.failed.map((f) => f.reason)).toEqual([EVIDENCE_NO_BROWSER, EVIDENCE_NO_BROWSER]);
    const changed = await setup(none.runner, { check: "mismatch" }).recorder.capture(
      setup(none.runner).request(),
    );
    expect(changed.failed[0]?.reason).toMatch(/does not match its pin/);
    expect(none.calls).toHaveLength(0);
  });

  it("reports a discarded file by the kinds the scan found, never the text", async () => {
    const { runner } = fakeRunner({
      "01-replay.webm": { status: "discarded", hits: ["github_token", "denied_text"] },
    });
    const { recorder, outDir, request } = setup(runner);
    const result = await recorder.capture(request({ denyText: ["acme-secret-client"] }));
    expect(result.files.map((f) => f.name)).toEqual(["02-gates.png"]);
    expect(result.failed).toEqual([
      {
        name: "01-replay.webm",
        reason:
          "the redaction scan found github_token, denied_text on the page, so the file was discarded",
      },
    ]);
    expect(existsSync(join(outDir, "01-replay.webm"))).toBe(false);
  });

  it("removes secrets and denied values from every reason it reports", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const { runner } = fakeRunner({
      "02-gates.png": {
        status: "failed",
        detail: `waiting for text "Acme-Corp" near ${token} timed out`,
      },
    });
    const { recorder, request } = setup(runner);
    const result = await recorder.capture(request({ denyText: ["acme-corp"] }));
    const reason = result.failed[0]?.reason ?? "";
    expect(reason).not.toMatch(/acme-corp/i);
    expect(reason).not.toContain(token);
    expect(reason).toContain("[REDACTED]");
    expect(cleanReason("the run failed at /Users/me/x for ACME", ["/Users/me", "acme"])).toBe(
      "the run failed at [REDACTED:known_value]/x for [REDACTED]",
    );
  });

  it("removes a short denied value from a reason only as a whole word (reading 212(12))", () => {
    expect(cleanReason("the build of the UI failed", ["ui"])).toBe(
      "the build of the [REDACTED] failed",
    );
    expect(cleanReason("AcmeCorp failed", ["acme"])).toBe("[REDACTED]Corp failed");
  });

  it("fails every shot with a clean reason when the runner fails", async () => {
    const failing: EvidenceRunner = {
      run: () => Promise.resolve({ ok: false, reason: "the evidence runner timed out for acme" }),
    };
    const { recorder, request } = setup(failing);
    const result = await recorder.capture(request({ denyText: ["acme"] }));
    expect(result.files).toEqual([]);
    expect(result.failed).toEqual([
      { name: "01-replay.webm", reason: "the evidence runner timed out for [REDACTED]" },
      { name: "02-gates.png", reason: "the evidence runner timed out for [REDACTED]" },
    ]);
    const crashed = fakeRunner({}, { error: "browser did not start" });
    const out = await setup(crashed.runner).recorder.capture(request());
    expect(out.files).toEqual([]);
    expect(out.failed[0]?.reason).toMatch(/the evidence runner failed: browser did not start/);
  });

  it("fails a file over its budget", async () => {
    const big = Buffer.alloc(EVIDENCE_LIMITS.maxPngBytes + 1, 1);
    const { runner } = fakeRunner({ "02-gates.png": { bytes: big } });
    const { recorder, outDir, request } = setup(runner);
    const result = await recorder.capture(request());
    expect(result.failed[0]).toMatchObject({ name: "02-gates.png" });
    expect(result.failed[0]?.reason).toMatch(/over its 1\.5 MB budget/);
    expect(existsSync(join(outDir, "02-gates.png"))).toBe(false);
  });

  it("fails the files that would take one capture over the per-PR byte budget", async () => {
    const video = Buffer.alloc(EVIDENCE_LIMITS.maxVideoBytes - 1024, 1);
    const { runner } = fakeRunner({
      "01-replay.webm": { bytes: video },
      "02-flow.webm": { bytes: video },
      "03-small.png": { bytes: PNG },
    });
    const { recorder, outDir, request } = setup(runner);
    const result = await recorder.capture(
      request({
        shots: [
          shot("01-replay.webm", { videoSeconds: 12 }),
          shot("02-flow.webm", { kind: "flow_video", videoSeconds: 10 }),
          shot("03-small.png"),
        ],
      }),
    );
    expect(result.files.map((f) => f.name)).toEqual(["01-replay.webm", "03-small.png"]);
    expect(result.files.reduce((sum, f) => sum + f.bytes, 0)).toBeLessThanOrEqual(
      EVIDENCE_LIMITS.maxBytesPerPr,
    );
    expect(result.failed).toEqual([
      {
        name: "02-flow.webm",
        reason: "the file would take this capture over the 10 MB evidence budget of a PR",
      },
    ]);
    expect(existsSync(join(outDir, "02-flow.webm"))).toBe(false);
  });

  it("never keeps a file the runner reported without its bytes", async () => {
    const { runner } = fakeRunner({});
    const lying: EvidenceRunner = {
      run: async (call) => {
        const outcome = await runner.run(call);
        return outcome.ok ? { ...outcome, file: () => null } : outcome;
      },
    };
    const { recorder, request } = setup(lying);
    const result = await recorder.capture(request());
    expect(result.files).toEqual([]);
    expect(result.failed[0]?.reason).toMatch(/missing or is not the one the runner wrote/);
  });

  it("replaces a link already in outDir instead of writing through it", async () => {
    const { runner } = fakeRunner({});
    const { recorder, outDir, request } = setup(runner);
    const outside = join(tempDir("vtc-evidence-outside-"), "victim.txt");
    writeFileSync(outside, "untouched");
    mkdirSync(outDir, { recursive: true });
    symlinkSync(outside, join(outDir, "02-gates.png"));
    await recorder.capture(request());
    expect(readFileSync(join(outDir, "02-gates.png"))).toEqual(PNG);
    expect(lstatSync(join(outDir, "02-gates.png")).isSymbolicLink()).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });
});
