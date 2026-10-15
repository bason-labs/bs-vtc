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
 * - Kinds: `replay_video` and `flow_video` are recordings, `screenshot`, `ui_before`, `ui_after`,
 *   `chart` and `gate_report` are screenshots; `replay_gif` is made from a recording later (with
 *   ffmpeg), never here. A shot whose kind, `videoSeconds` and extension disagree fails.
 * - Budget: a PNG over `EVIDENCE_LIMITS.maxPngBytes` or a recording over `maxVideoBytes` fails;
 *   recordings are WebM (no ffmpeg here), a replay at most `maxReplaySeconds` and a changed flow at
 *   most `maxFlowSeconds` long. One capture never returns more than `maxBytesPerPr` in all: a file
 *   that would go over it fails. The PR's total across captures and the project's lower
 *   `automation.evidence.max_mb` are applied by the caller, which knows both.
 *
 * Tests inject a fake {@link EvidenceRunner} or a fake Playwright module and never start a browser.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  EVIDENCE_LIMITS,
  EvidenceFileNameSchema,
  type BeforeAfterRequest,
  type BeforeAfterResult,
  SECRET_PATTERNS,
  type EvidenceCaptureRequest,
  type EvidenceCaptureResult,
  type EvidenceRecorder,
  type EvidenceShot,
  type GateReport,
  type GateSandbox,
} from "@vtc/shared";
import { createGitOps } from "../../git/index.js";
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
import { appLoopbackPort } from "../visual/app.js";
import {
  engineNodeExecutable,
  LINUX_PTRACE_REFUSAL,
  NO_RUNNER_NODE,
  readPtraceScope,
  resolveNodeExecutable,
  runSignedScript,
  type SignedScriptOutcome,
} from "../visual/runner.js";
import {
  DENY_SUBSTRING_MIN,
  EVIDENCE_MASK_COLOR,
  EVIDENCE_PAINT_DEFAULTS,
  EVIDENCE_VIDEO_SIZE,
  EvidenceRunnerResultSchema,
  MAX_SCAN_CHARS,
  type EvidenceRunnerInput,
  type EvidenceRunnerResult,
  type EvidenceRunnerShot,
} from "./protocol.js";
import { captureBeforeAfter } from "./before-after.js";
import { cleanReason } from "./clean.js";
import { gateReportHtml, GATE_REPORT_HTML } from "./report-html.js";
import { EVIDENCE_RUNNER_SCRIPT } from "./script.js";
import type { CaptureTarget, TargetCaptureResult } from "./target.js";

export interface EvidenceRunnerCall {
  readonly input: Omit<EvidenceRunnerInput, "out_dir">;
  /** Absolute directories the script must read (the browser store). */
  readonly allowRead: readonly string[];
  /** The origin's port. */
  readonly port: number;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /**
   * With `input.app`: the absolute clean gate checkout the app is served from, the only directory
   * the script and the app may write besides their temp directory. Absent: the jail's home.
   */
  readonly checkout?: string;
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
  /** Test seams of the default runner: the host platform and its ptrace policy (reading 164). */
  readonly platform?: NodeJS.Platform;
  readonly ptraceScope?: () => string | null;
}

/** Why nothing is captured without the doctor-installed browser store. */
export const EVIDENCE_NO_BROWSER =
  "no browser for evidence capture: run vtc doctor --install-browser (evidence is captured only with the browser store, never the project's own Playwright)";
/** Why nothing is captured without a sandbox. */
export const EVIDENCE_NO_SANDBOX =
  "no gate sandbox on this machine (vtc doctor says why), so no evidence is captured";

const NAV_TIMEOUT_MS = 30_000;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
/** Longest Unix socket path (Linux `sun_path` is 108 bytes with its NUL). */
const MAX_SOCKET_PATH = 107;

const VIDEO_KINDS: ReadonlySet<EvidenceShot["kind"]> = new Set(["replay_video", "flow_video"]);
const SCREENSHOT_KINDS: ReadonlySet<EvidenceShot["kind"]> = new Set([
  "screenshot",
  "ui_before",
  "ui_after",
  "chart",
  "gate_report",
]);

/** Why a shot cannot be captured as asked, or `null`. */
const shotProblem = (shot: EvidenceShot): string | null => {
  if (!EvidenceFileNameSchema.safeParse(shot.name).success) {
    return "the file name is not NN-<slug>.<png|gif|webm|mp4>";
  }
  if (shot.kind === "replay_gif") {
    return "a replay_gif is made from a replay_video later (with ffmpeg), never captured";
  }
  const video = VIDEO_KINDS.has(shot.kind);
  if (!video && !SCREENSHOT_KINDS.has(shot.kind)) return "the kind is not an evidence file kind";
  if (video !== (shot.videoSeconds !== undefined)) {
    return video
      ? `a ${shot.kind} is a recording: give it videoSeconds`
      : `a ${shot.kind} is a screenshot: it takes no videoSeconds`;
  }
  if (video && !shot.name.endsWith(".webm")) {
    return "a recording is WebM: name it .webm (GIFs and MP4 are made from it later, with ffmpeg)";
  }
  if (!video && !shot.name.endsWith(".png")) return "a screenshot is PNG: name it .png";
  if (video) {
    const s = shot.videoSeconds ?? 0;
    const max =
      shot.kind === "flow_video"
        ? EVIDENCE_LIMITS.maxFlowSeconds
        : EVIDENCE_LIMITS.maxReplaySeconds;
    if (!Number.isFinite(s) || s <= 0 || s > max) {
      return `a ${shot.kind} lasts more than 0 and at most ${String(max)} seconds`;
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

/**
 * The runner in the gate sandbox; `jail` is `null` without a sandbox (nothing runs). With an app
 * server (before/after), a Linux host whose ptrace policy would let the app reach the runner runs
 * nothing ({@link LINUX_PTRACE_REFUSAL}, reading 164), as in the visual step.
 */
export const sandboxedEvidenceRunner = (
  jail: GateCommandJail | null,
  node: string | null,
  host: {
    readonly platform?: NodeJS.Platform;
    readonly ptraceScope?: () => string | null;
  } = {},
): EvidenceRunner => ({
  run: async (call) => {
    if (jail === null) return { ok: false, reason: EVIDENCE_NO_SANDBOX };
    if (node === null || !isAbsolute(node)) return { ok: false, reason: NO_RUNNER_NODE };
    if (call.input.app != null && (host.platform ?? process.platform) === "linux") {
      const scope = Number((host.ptraceScope ?? readPtraceScope)() ?? "0");
      if (!(scope >= 1)) return { ok: false, reason: LINUX_PTRACE_REFUSAL };
    }
    const logs = mkdtempSync(join(tmpdir(), "vtc-evidence-logs-"));
    let relay: Server | null = null;
    const sockets = new Set<Socket>();
    let relayError: string | null = null;
    try {
      const outcome = await runSignedScript(
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
          checkout: call.checkout ?? jail.homeDir(),
          timeoutMs: call.timeoutMs,
          stdoutPath: join(logs, "stdout.log"),
          stderrPath: join(logs, "stderr.log"),
          setup: (tmp) => {
            if (!call.input.relay) return;
            const path = join(tmp, "relay.sock");
            if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
              throw new Error(
                `the relay socket path is longer than ${String(MAX_SOCKET_PATH)} bytes; set TMPDIR to a shorter directory`,
              );
            }
            // Bound before the command starts (a pipe binds synchronously); forwards only to the origin.
            const server = createServer((client) => {
              const upstream = connect({ host: "127.0.0.1", port: call.port });
              sockets.add(client).add(upstream);
              const end = (): void => {
                client.destroy();
                upstream.destroy();
              };
              client.on("error", end);
              upstream.on("error", end);
              client.on("close", () => sockets.delete(client));
              upstream.on("close", () => sockets.delete(upstream));
              client.pipe(upstream).pipe(client);
            });
            // A relay that cannot listen fails the capture instead of the engine.
            server.on("error", (error) => {
              relayError ??= `the evidence relay failed: ${error.message}`;
            });
            server.listen(path);
            relay = server;
          },
        },
        EvidenceRunnerResultSchema,
      );
      const failed = relayError as string | null;
      return failed === null ? outcome : { ok: false, reason: failed };
    } finally {
      (relay as Server | null)?.close();
      for (const socket of sockets) socket.destroy();
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

  /** One capture of `request` against `target` (the public `capture`, or one before/after side). */
  const captureShots = async (
    request: EvidenceCaptureRequest,
    target: CaptureTarget,
  ): Promise<TargetCaptureResult> => {
    const deny = [...new Set(request.denyText.map((v) => v.trim()).filter((v) => v !== ""))];
    const failed: { name: string; reason: string }[] = [];
    const failAll = (
      reason: string,
      shots: readonly { readonly name: string }[],
      app?: "served" | "failed",
    ): TargetCaptureResult => {
      const clean = cleanReason(reason, deny);
      return {
        files: [],
        failed: [...failed, ...shots.map((s) => ({ name: s.name, reason: clean }))],
        ...(app === undefined ? {} : { app }),
      };
    };

    // The request: a loopback origin (the app's own, when one is served), an output directory,
    // shots within the budget.
    let port = 0;
    if (target.app === undefined) {
      const origin = LOOPBACK_ORIGIN.exec(request.origin);
      port = origin === null ? 0 : Number(origin[1]);
      if (origin === null || port > 65_535) {
        return failAll("the capture origin is not http://127.0.0.1:<port>", request.shots);
      }
    } else {
      let appOrigin: string | null;
      try {
        appOrigin = new URL(target.app.url).origin;
        port = appLoopbackPort(target.app.url);
      } catch {
        appOrigin = null;
      }
      if (appOrigin === null || appOrigin !== request.origin || !isAbsolute(target.app.cwd)) {
        return failAll(
          "the capture origin is not the app server's own loopback origin",
          request.shots,
        );
      }
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

    let visual: ReturnType<CaptureTarget["visual"]>;
    try {
      visual = target.visual();
    } catch (error) {
      return failAll(error instanceof Error ? error.message : String(error), shots);
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

    // The jail: the target's (left open for its caller), else one of this capture's own.
    let jail: GateCommandJail | null = target.jail === undefined ? null : target.jail;
    let ownJail: GateCommandJail | null = null;
    let runner = options.runner;
    if (runner === undefined) {
      if (target.jail === undefined) {
        const sandbox = resolveGateSandbox(
          deps,
          options.detectSandbox ?? (() => detectGateSandbox().sandbox),
        );
        if (sandbox !== null) {
          const policy = gateReadPolicy({
            vtcHome: deps.vtcHome,
            env,
            ...(deps.repoRoot === undefined ? {} : { repoRoot: deps.repoRoot }),
          });
          ownJail = new GateCommandJail(sandbox, policy.denyRead, policy);
          jail = ownJail;
        }
      }
      const exclude = [
        ...(deps.repoRoot === undefined ? [] : [deps.repoRoot]),
        ...(target.app === undefined ? [] : [target.app.checkout]),
      ];
      runner = sandboxedEvidenceRunner(
        jail,
        options.node ?? resolveNodeExecutable(env.PATH, exclude, engineNodeExecutable()),
        {
          ...(options.platform === undefined ? {} : { platform: options.platform }),
          ...(options.ptraceScope === undefined ? {} : { ptraceScope: options.ptraceScope }),
        },
      );
    }
    const runnerShots: EvidenceRunnerShot[] = shots.map((s) => {
      const scheme = target.colorSchemes?.get(s.name);
      return {
        name: s.name,
        path: s.path,
        width: s.viewport.width,
        height: s.viewport.height,
        ...(s.videoSeconds === undefined ? {} : { video_seconds: s.videoSeconds }),
        ...(s.waitFor === undefined ? {} : { wait_for: s.waitFor }),
        ...(scheme === undefined ? {} : { color_scheme: scheme }),
      };
    });
    const recording = shots.reduce((sum, s) => sum + (s.videoSeconds ?? 0), 0);
    const app = target.app;
    // The jail's temp directory holds the runner's files until they are copied out below.
    try {
      const outcome = await runner.run({
        input: {
          v: 1,
          playwright: toolchain.playwright,
          executable: check.pin.executable,
          origin: request.origin,
          // An app is served inside the sandbox, on its own loopback: nothing to relay.
          relay: app === undefined && jail?.kind === "bwrap",
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
          deny_substring_min: DENY_SUBSTRING_MIN,
          max_scan_chars: MAX_SCAN_CHARS,
          shots: runnerShots,
          app:
            app === undefined
              ? null
              : {
                  command: app.command,
                  cwd: app.cwd,
                  url: app.url,
                  ready_timeout_ms: app.readyTimeoutMs,
                },
        },
        allowRead: toolchain.readable,
        port,
        env: { ...gateEnv(env), PLAYWRIGHT_BROWSERS_PATH: toolchain.browsersPath },
        timeoutMs: Math.min(
          app === undefined ? 600_000 : 600_000 + app.readyTimeoutMs,
          60_000 +
            shots.length * 2 * NAV_TIMEOUT_MS +
            recording * 1000 +
            (app === undefined ? 0 : app.readyTimeoutMs),
        ),
        ...(app === undefined ? {} : { checkout: app.checkout }),
      });
      if (!outcome.ok) return failAll(outcome.reason, shots);
      const served = outcome.result.app;
      if (outcome.result.error !== undefined) {
        return failAll(`the evidence runner failed: ${outcome.result.error}`, shots, served);
      }
      if (app !== undefined && served !== "served") {
        return failAll(
          "the evidence runner did not say that the app server served",
          shots,
          "failed",
        );
      }
      const kept = keep(
        outcome,
        shots,
        request.outDir,
        deny,
        failed,
        target.budgetBytes ?? EVIDENCE_LIMITS.maxBytesPerPr,
      );
      return served === undefined ? kept : { ...kept, app: served };
    } finally {
      ownJail?.dispose();
    }
  };

  const capture = async (request: EvidenceCaptureRequest): Promise<EvidenceCaptureResult> => {
    // The project's own selectors (gates.yml `visual`), read at each capture.
    const visual = (): ReturnType<CaptureTarget["visual"]> => {
      if (deps.repoRoot === undefined) return { redact: [], dynamic: [] };
      let config;
      try {
        config = loadGatesConfig(deps.repoRoot);
      } catch (error) {
        throw new Error(
          `.vtc/gates.yml could not be read, so its visual.redact_selectors are unknown: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return {
        redact: config?.visual?.redact_selectors ?? [],
        dynamic: config?.visual?.dynamic_regions ?? [],
      };
    };
    const { files, failed } = await captureShots(request, { visual });
    return { files, failed };
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

  const beforeAfter = (request: BeforeAfterRequest): Promise<BeforeAfterResult> =>
    captureBeforeAfter(
      {
        vtcHome: deps.vtcHome,
        env,
        sandbox: () =>
          resolveGateSandbox(deps, options.detectSandbox ?? (() => detectGateSandbox().sandbox)),
        git: (repoRoot) => createGitOps({ repoRoot }),
        browserProblem: async () => {
          const toolchain = toolchainOf(deps.vtcHome);
          const check = toolchain === null ? null : await checkBrowser(deps.vtcHome);
          if (toolchain === null || check === null) {
            return { reason: "no_browser", detail: EVIDENCE_NO_BROWSER };
          }
          return check.ok
            ? null
            : {
                reason: "capture_failed",
                detail:
                  "the doctor-installed browser does not match its pin; vtc doctor --install-browser installs it again",
              };
        },
        capture: captureShots,
      },
      request,
    ).catch(() => ({
      files: [],
      failed: [],
      partial: { reason: "capture_failed", detail: "the before/after capture failed unexpectedly" },
    }));

  return { capture, captureBeforeAfter: beforeAfter, renderGateReport };
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
  budget: number,
): EvidenceCaptureResult => {
  mkdirSync(outDir, { recursive: true });
  const files: { name: string; kind: EvidenceShot["kind"]; bytes: number }[] = [];
  let total = 0;
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
    if (total + bytes.length > budget) {
      fail(
        `the file would take this capture over the ${(EVIDENCE_LIMITS.maxBytesPerPr / (1024 * 1024)).toFixed(0)} MB evidence budget of a PR`,
      );
      continue;
    }
    total += bytes.length;
    const target = join(outDir, shot.name);
    // Never through a file or link already there.
    rmSync(target, { force: true });
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    files.push({ name: shot.name, kind: shot.kind, bytes: bytes.length });
  }
  return { files, failed };
};
