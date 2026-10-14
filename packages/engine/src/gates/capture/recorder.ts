/**
 * `EvidenceRecorder` (`@vtc/shared` `interfaces/automation.ts`; AD-27 rule 6, D-ce, spine §5
 * readings 207 and 208): Playwright capture of the evidence snapshot server's loopback pages for
 * automatic PRs, as an `evidence` job of the visual stack (AD-24): the browser store's Playwright
 * and its pinned browser, re-verified before every capture, run by a VTC-written script in the
 * gate sandbox with a signed result (`visual/runner.ts` `runSignedScript`). Nothing is downloaded.
 *
 * - Toolchain: only the store `vtc doctor --install-browser` filled (`storeToolchain`,
 *   `checkStoreBrowser`). The project's own Playwright is never used here: it is code the
 *   project's dependencies can change, and the redaction verdict that lets a file leave the
 *   machine must not rest on it (the reasoning of reading 124). No store: every shot fails.
 * - Network: the browser reaches only `request.origin` (`http://127.0.0.1:<port>`); the sandbox
 *   opens that one host port (macOS), or the script relays it through a socket the recorder
 *   forwards (Linux, whose sandbox has a loopback of its own).
 * - Redaction, fail closed: `redactSelectors`, `EVIDENCE_PAINT_DEFAULTS` and the project's
 *   `visual.redact_selectors` are painted in every frame and masked on screenshots, with
 *   `visual.dynamic_regions` masked too; page text is scanned against `SECRET_PATTERNS` and
 *   `denyText` before and after every screenshot and throughout a recording. A hit discards the
 *   file; a project `gates.yml` that cannot be read fails every shot, since its selectors are
 *   unknown. Every reason passes `redactSecrets` and has each `denyText` value removed, so no
 *   matched text is ever reported.
 * - Budget: a PNG over `EVIDENCE_LIMITS.maxPngBytes` or a recording over `maxVideoBytes` fails;
 *   recordings are WebM (no ffmpeg here), at most `maxReplaySeconds` long.
 *
 * Tests inject a fake {@link EvidenceRunner} or a fake Playwright module and never start a browser.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  EVIDENCE_LIMITS,
  EvidenceFileNameSchema,
  redactSecrets,
  SECRET_PATTERNS,
  type EvidenceCaptureRequest,
  type EvidenceCaptureResult,
  type EvidenceRecorder,
  type EvidenceShot,
  type GateReport,
  type GateSandbox,
} from "@vtc/shared";
import { loadGatesConfig } from "../config.js";
import { gateEnv } from "../exec.js";
import {
  GateCommandJail,
  gateReadPolicy,
  resolveGateSandbox,
  detectGateSandbox,
} from "../sandbox.js";
import {
  checkStoreBrowser,
  storeToolchain,
  type BrowserCheck,
  type VisualToolchain,
} from "../visual/browser.js";
import {
  engineNodeExecutable,
  NO_RUNNER_NODE,
  resolveNodeExecutable,
  runSignedScript,
  type SignedScriptOutcome,
} from "../visual/runner.js";
import {
  EVIDENCE_MASK_COLOR,
  EVIDENCE_PAINT_DEFAULTS,
  EVIDENCE_VIDEO_SIZE,
  EvidenceRunnerResultSchema,
  MAX_SCAN_CHARS,
  type EvidenceRunnerInput,
  type EvidenceRunnerResult,
  type EvidenceRunnerShot,
} from "./protocol.js";
import { gateReportHtml, GATE_REPORT_HTML } from "./report-html.js";
import { EVIDENCE_RUNNER_SCRIPT } from "./script.js";

export interface EvidenceRunnerCall {
  readonly input: Omit<EvidenceRunnerInput, "out_dir">;
  /** Absolute directories the script must read (the browser store). */
  readonly allowRead: readonly string[];
  /** The origin's port. */
  readonly port: number;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** Runs the evidence script; the default is {@link sandboxedEvidenceRunner}. */
export interface EvidenceRunner {
  run(call: EvidenceRunnerCall): Promise<SignedScriptOutcome<EvidenceRunnerResult>>;
}

/** What `createEvidenceRecorder` needs; the cli passes the same values as to the Gate Runner. */
export interface EvidenceRecorderDeps {
  /** Absolute VTC home: the browser store and its pin. */
  readonly vtcHome: string;
  /**
   * Absolute repo root of the project whose engine captures: its `.vtc/gates.yml` `visual`
   * (`redact_selectors`, `dynamic_regions`) is read at each capture. Absent: none.
   */
  readonly repoRoot?: string;
  /** The gate sandbox (D-al); absent: detected. */
  readonly sandbox?: GateSandbox;
  /** `~/.vtc/config.yaml` `gates.allow_unsandboxed`. */
  readonly allowUnsandboxed?: boolean;
}

export interface EvidenceRecorderOptions {
  /** The engine's environment, scrubbed before the script sees it (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly detectSandbox?: () => GateSandbox | null;
  /** The absolute Node the script runs with (default as the visual step). */
  readonly node?: string;
  /** Test seam: runs the script (default in the gate sandbox). */
  readonly runner?: EvidenceRunner;
  /** Test seams: the browser store and its pin check. */
  readonly toolchain?: (vtcHome: string) => VisualToolchain | null;
  readonly checkBrowser?: (vtcHome: string) => Promise<BrowserCheck | null>;
}

/** Why nothing is captured without the doctor-installed browser store. */
export const EVIDENCE_NO_BROWSER =
  "no browser for evidence capture: run vtc doctor --install-browser (evidence is captured only with the browser store, never the project's own Playwright)";
/** Why nothing is captured without a sandbox. */
export const EVIDENCE_NO_SANDBOX =
  "no gate sandbox on this machine (vtc doctor says why), so no evidence is captured";

const NAV_TIMEOUT_MS = 30_000;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
const MAX_REASON = 300;

/** A reason with no secret and no `denyText` value in it. */
export const cleanReason = (text: string, denyText: readonly string[]): string => {
  let out = redactSecrets(text, denyText);
  for (const value of denyText) {
    const v = value.trim();
    if (v === "") continue;
    out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[REDACTED]");
  }
  return out.length > MAX_REASON ? `${out.slice(0, MAX_REASON - 1)}…` : out;
};

/** Why a shot cannot be captured as asked, or `null`. */
const shotProblem = (shot: EvidenceShot): string | null => {
  if (!EvidenceFileNameSchema.safeParse(shot.name).success) {
    return "the file name is not NN-<slug>.<png|gif|webm|mp4>";
  }
  const video = shot.videoSeconds !== undefined;
  if (video && !shot.name.endsWith(".webm")) {
    return "a recording is WebM: name it .webm (GIFs and MP4 are made from it later, with ffmpeg)";
  }
  if (!video && !shot.name.endsWith(".png")) return "a screenshot is PNG: name it .png";
  if (video) {
    const s = shot.videoSeconds ?? 0;
    if (!Number.isFinite(s) || s <= 0 || s > EVIDENCE_LIMITS.maxReplaySeconds) {
      return `a recording lasts more than 0 and at most ${String(EVIDENCE_LIMITS.maxReplaySeconds)} seconds`;
    }
  }
  const { width, height } = shot.viewport;
  const sane = (n: number) => Number.isInteger(n) && n >= 200 && n <= 4000;
  if (!sane(width) || !sane(height)) return "the viewport is not 200 to 4000 pixels each way";
  if (!shot.path.startsWith("/") || shot.path.startsWith("//") || /[\s\\]/.test(shot.path)) {
    return "the path must start with one / and hold no whitespace or backslash";
  }
  if (shot.path.length > 2000) return "the path is too long";
  if (shot.waitFor !== undefined && (shot.waitFor.length === 0 || shot.waitFor.length > 300)) {
    return "waitFor is not a selector";
  }
  return null;
};

/** The runner in the gate sandbox; `jail` is `null` without a sandbox (nothing runs). */
export const sandboxedEvidenceRunner = (
  jail: GateCommandJail | null,
  node: string | null,
): EvidenceRunner => ({
  run: async (call) => {
    if (jail === null) return { ok: false, reason: EVIDENCE_NO_SANDBOX };
    if (node === null || !isAbsolute(node)) return { ok: false, reason: NO_RUNNER_NODE };
    const logs = mkdtempSync(join(tmpdir(), "vtc-evidence-logs-"));
    let relay: Server | null = null;
    try {
      return await runSignedScript(
        jail,
        node,
        {
          script: EVIDENCE_RUNNER_SCRIPT,
          label: "evidence runner",
          input: call.input,
          allowRead: call.allowRead,
          // Linux relays through a socket instead: its sandbox opens no host port.
          loopbackPort: call.input.relay ? null : call.port,
          env: call.env,
          checkout: jail.homeDir(),
          timeoutMs: call.timeoutMs,
          stdoutPath: join(logs, "stdout.log"),
          stderrPath: join(logs, "stderr.log"),
          setup: (tmp) => {
            if (!call.input.relay) return;
            // Bound before the command starts (a pipe binds synchronously); forwards only to the origin.
            relay = createServer((client) => {
              const upstream = connect({ host: "127.0.0.1", port: call.port });
              const end = (): void => {
                client.destroy();
                upstream.destroy();
              };
              client.on("error", end);
              upstream.on("error", end);
              client.pipe(upstream).pipe(client);
            });
            relay.listen(join(tmp, "relay.sock"));
          },
        },
        EvidenceRunnerResultSchema,
      );
    } finally {
      (relay as Server | null)?.close();
      rmSync(logs, { recursive: true, force: true });
    }
  },
});

/** The gate-runner's `EvidenceRecorder` (`gates.createEvidenceRecorder`). */
export const createEvidenceRecorder = (
  deps: EvidenceRecorderDeps,
  options: EvidenceRecorderOptions = {},
): EvidenceRecorder => {
  const env = options.env ?? process.env;
  const toolchainOf = options.toolchain ?? storeToolchain;
  const checkBrowser = options.checkBrowser ?? checkStoreBrowser;

  const capture = async (request: EvidenceCaptureRequest): Promise<EvidenceCaptureResult> => {
    const deny = [...new Set(request.denyText.map((v) => v.trim()).filter((v) => v !== ""))];
    const failed: { name: string; reason: string }[] = [];
    const failAll = (reason: string, shots: readonly { readonly name: string }[]) => {
      const clean = cleanReason(reason, deny);
      return {
        files: [],
        failed: [...failed, ...shots.map((s) => ({ name: s.name, reason: clean }))],
      };
    };

    // The request: a loopback origin, an output directory, shots within the budget.
    const origin = LOOPBACK_ORIGIN.exec(request.origin);
    const port = origin === null ? 0 : Number(origin[1]);
    if (origin === null || port > 65_535) {
      return failAll("the capture origin is not http://127.0.0.1:<port>", request.shots);
    }
    if (!isAbsolute(request.outDir)) return failAll("outDir is not absolute", request.shots);
    const names = new Set<string>();
    const shots: EvidenceShot[] = [];
    for (const shot of request.shots) {
      const problem = names.has(shot.name) ? "the file name is used twice" : shotProblem(shot);
      names.add(shot.name);
      if (problem !== null) failed.push({ name: shot.name, reason: cleanReason(problem, deny) });
      else if (shots.length >= EVIDENCE_LIMITS.maxFilesPerPr) {
        failed.push({
          name: shot.name,
          reason: `more than ${String(EVIDENCE_LIMITS.maxFilesPerPr)} files in one capture`,
        });
      } else shots.push(shot);
    }
    if (shots.length === 0) return { files: [], failed };

    // The project's own selectors (gates.yml `visual`), read now; unreadable fails closed.
    let visual: { redact: readonly string[]; dynamic: readonly string[] } = {
      redact: [],
      dynamic: [],
    };
    if (deps.repoRoot !== undefined) {
      try {
        const config = loadGatesConfig(deps.repoRoot);
        visual = {
          redact: config?.visual?.redact_selectors ?? [],
          dynamic: config?.visual?.dynamic_regions ?? [],
        };
      } catch (error) {
        return failAll(
          `.vtc/gates.yml could not be read, so its visual.redact_selectors are unknown: ${error instanceof Error ? error.message : String(error)}`,
          shots,
        );
      }
    }
    const paint = [
      ...new Set([...EVIDENCE_PAINT_DEFAULTS, ...request.redactSelectors, ...visual.redact]),
    ];
    const mask = [...new Set([...paint, ...visual.dynamic])];

    // The browser store and its pin, re-verified (AD-24 rule 2).
    const toolchain = toolchainOf(deps.vtcHome);
    const check = toolchain === null ? null : await checkBrowser(deps.vtcHome);
    if (toolchain === null || check === null) return failAll(EVIDENCE_NO_BROWSER, shots);
    if (!check.ok) return failAll(check.reason, shots);

    let jail: GateCommandJail | null = null;
    let runner = options.runner;
    if (runner === undefined) {
      const sandbox = resolveGateSandbox(
        deps,
        options.detectSandbox ?? (() => detectGateSandbox().sandbox),
      );
      if (sandbox !== null) {
        const policy = gateReadPolicy({ vtcHome: deps.vtcHome, env });
        jail = new GateCommandJail(sandbox, policy.denyRead, policy);
      }
      const exclude = deps.repoRoot === undefined ? [] : [deps.repoRoot];
      runner = sandboxedEvidenceRunner(
        jail,
        options.node ?? resolveNodeExecutable(env.PATH, exclude, engineNodeExecutable()),
      );
    }
    const runnerShots: EvidenceRunnerShot[] = shots.map((s) => ({
      name: s.name,
      path: s.path,
      width: s.viewport.width,
      height: s.viewport.height,
      ...(s.videoSeconds === undefined ? {} : { video_seconds: s.videoSeconds }),
      ...(s.waitFor === undefined ? {} : { wait_for: s.waitFor }),
    }));
    const recording = shots.reduce((sum, s) => sum + (s.videoSeconds ?? 0), 0);
    // The jail's temp directory holds the runner's files until they are copied out below.
    try {
      const outcome = await runner.run({
        input: {
          v: 1,
          playwright: toolchain.playwright,
          executable: check.pin.executable,
          origin: request.origin,
          relay: jail?.kind === "bwrap",
          video_size: { ...EVIDENCE_VIDEO_SIZE },
          nav_timeout_ms: NAV_TIMEOUT_MS,
          paint,
          mask,
          mask_color: EVIDENCE_MASK_COLOR,
          patterns: SECRET_PATTERNS.map((p) => ({
            kind: p.kind,
            source: p.pattern.source,
            flags: p.pattern.flags,
          })),
          deny_text: deny,
          max_scan_chars: MAX_SCAN_CHARS,
          shots: runnerShots,
        },
        allowRead: toolchain.readable,
        port,
        env: { ...gateEnv(env), PLAYWRIGHT_BROWSERS_PATH: toolchain.browsersPath },
        timeoutMs: Math.min(600_000, 60_000 + shots.length * 2 * NAV_TIMEOUT_MS + recording * 1000),
      });
      if (!outcome.ok) return failAll(outcome.reason, shots);
      if (outcome.result.error !== undefined) {
        return failAll(`the evidence runner failed: ${outcome.result.error}`, shots);
      }
      return keep(outcome, shots, request.outDir, deny, failed);
    } finally {
      jail?.dispose();
    }
  };

  const renderGateReport = (request: {
    readonly report: GateReport;
    readonly outDir: string;
  }): Promise<{ readonly html: string }> => {
    try {
      if (!isAbsolute(request.outDir)) throw new Error("outDir is not absolute");
      const html = gateReportHtml(request.report);
      mkdirSync(request.outDir, { recursive: true });
      const target = join(request.outDir, GATE_REPORT_HTML);
      rmSync(target, { force: true });
      writeFileSync(target, html, { flag: "wx", mode: 0o600 });
      return Promise.resolve({ html: GATE_REPORT_HTML });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  return { capture, renderGateReport };
};

/**
 * Copies the files the runner captured, and that passed the scan and the budget, into `outDir`
 * (from the jail's temp directory, before it is removed); everything else is a failed shot.
 */
const keep = (
  outcome: Extract<SignedScriptOutcome<EvidenceRunnerResult>, { ok: true }>,
  shots: readonly EvidenceShot[],
  outDir: string,
  deny: readonly string[],
  failed: { name: string; reason: string }[],
): EvidenceCaptureResult => {
  mkdirSync(outDir, { recursive: true });
  const files: { name: string; kind: EvidenceShot["kind"]; bytes: number }[] = [];
  for (const shot of shots) {
    const fail = (reason: string) =>
      failed.push({ name: shot.name, reason: cleanReason(reason, deny) });
    const result = outcome.result.shots.find((r) => r.name === shot.name);
    if (result === undefined) {
      fail("the evidence runner reported nothing for this shot");
      continue;
    }
    if (result.status === "discarded") {
      const kinds = result.hits.length === 0 ? "text it may not show" : result.hits.join(", ");
      fail(`the redaction scan found ${kinds} on the page, so the file was discarded`);
      continue;
    }
    if (result.status === "failed") {
      fail(result.detail ?? "the capture failed");
      continue;
    }
    const bytes = result.file === shot.name ? outcome.file(shot.name) : null;
    if (bytes === null) {
      fail("the captured file is missing or is not the one the runner wrote");
      continue;
    }
    const cap =
      shot.videoSeconds === undefined ? EVIDENCE_LIMITS.maxPngBytes : EVIDENCE_LIMITS.maxVideoBytes;
    if (bytes.length > cap) {
      fail(
        `the file is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB, over its ${(cap / (1024 * 1024)).toFixed(1)} MB budget; use a smaller viewport or a shorter recording`,
      );
      continue;
    }
    const target = join(outDir, shot.name);
    // Never through a file or link already there.
    rmSync(target, { force: true });
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    files.push({ name: shot.name, kind: shot.kind, bytes: bytes.length });
  }
  return { files, failed };
};
