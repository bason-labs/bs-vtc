/**
 * UI before/after evidence for an automatic PR (D-ct; spine §5 reading 223;
 * `EvidenceRecorder.captureBeforeAfter`): for the base and then the head, a clean gate checkout of
 * that commit (never the user's work tree), its install-phase gates and its unconditional L0
 * build gates in the gate sandbox, then the app server of the project's committed `gates.yml`
 * (`visual.app`, read at the base like every gate) served in that checkout by the evidence runner,
 * which renders the Visual QA screens (`screens.yaml`, or the request's `screens`) at the Visual
 * QA widths and themes (`visualConfigFor`) and, with `flowSeconds`, records the changed flow.
 * Build time, no AI tokens; nothing is downloaded at capture time.
 *
 * - Commands: only what this machine's gate allowlist confirms (§15): the build gates and
 *   `visual.app.command`. A gate that needs a diff (`{changed}`, `{rules}`) or only runs when
 *   some paths change (`when_changed`) is a check, not a build, and does not run here.
 * - Redaction: every frame passes the same layers as `capture` (the request's `redactSelectors`,
 *   VTC's defaults and the committed `visual.redact_selectors` painted and masked,
 *   `visual.dynamic_regions` masked, the text scan against `SECRET_PATTERNS` and `denyText`, fail
 *   closed).
 * - Names and budget: `NN-ui<k>-w<width>-<theme>-before|after.png` (`ui_before` / `ui_after`) and
 *   `NN-flow-before|after.webm` (`flow_video`), numbered so each pair sorts together; neutral, with
 *   no project text. At most `EVIDENCE_LIMITS.maxFilesPerPr` files and `maxBytesPerPr` bytes in
 *   all: renders past the file budget are left out and listed in `failed`
 *   ({@link BEFORE_AFTER_FILE_LIMIT_REASON}).
 * - Partial: whatever was captured is returned, with `partial` when a side or a shot is missing:
 *   `base_build_failed` / `base_serve_failed` for the base, `no_visual_app`, `no_browser`, and
 *   `capture_failed` for everything else (the head, a discarded or failed shot, a bad request).
 *   Every detail is VTC's own fixed text with no project text in it (no gate ids, commands, paths
 *   or app output).
 * - Build logs stay local under `.vtc/state/gates/before-after/` (AD-18).
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  DESIGN_SCREENS_PATH,
  EVIDENCE_LIMITS,
  gateCommandAllowed,
  GitShaSchema,
  visualConfigFor,
  type BeforeAfterRequest,
  type BeforeAfterResult,
  type EvidenceCaptureRequest,
  type EvidencePartialReason,
  type EvidenceShot,
  type Gate,
  type GatesConfig,
  type GateSandbox,
  type GitOps,
  type GitSha,
} from "@vtc/shared";
import { GATES_CONFIG_PATH, parseGatesConfig, readAllowlist } from "../config.js";
import { GATES_STATE_DIR } from "../evidence.js";
import { gateEnv } from "../exec.js";
import { GateCommandJail, gateReadPolicy } from "../sandbox.js";
import { expandMatrix, parseScreens, type RenderJob } from "../visual/matrix.js";
import { cleanReason } from "./clean.js";
import { EVIDENCE_VIDEO_SIZE, UI_VIEWPORT_HEIGHT } from "./protocol.js";
import type { CaptureTarget, TargetCaptureResult } from "./target.js";

/** Why a render was left out: one PR carries at most `maxFilesPerPr` evidence files. */
export const BEFORE_AFTER_FILE_LIMIT_REASON = `left out: a PR carries at most ${String(EVIDENCE_LIMITS.maxFilesPerPr)} evidence files; name fewer screens to capture this one`;
/** Where the raw output of the base and head builds stays (gitignored, never evidence). */
export const BEFORE_AFTER_STATE_DIR = `${GATES_STATE_DIR}/before-after`;

/** What the before/after capture needs from the recorder that owns it. */
export interface BeforeAfterContext {
  readonly vtcHome: string;
  /** The engine's environment, scrubbed (`gateEnv`) before any command sees it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The gate sandbox (D-al), or `null`: nothing is built. */
  readonly sandbox: () => GateSandbox | null;
  /** Git over the project checkout the run belongs to. */
  readonly git: (
    repoRoot: string,
  ) => Pick<GitOps, "readFileAtCommit" | "createCleanCheckout" | "removeCheckout">;
  /** The doctor-installed browser store and its pin: `null` when it is ready. */
  readonly browserProblem: () => Promise<{
    readonly reason: EvidencePartialReason;
    readonly detail: string;
  } | null>;
  /** One capture against a served app (the recorder's core). */
  readonly capture: (
    request: EvidenceCaptureRequest,
    target: CaptureTarget,
  ) => Promise<TargetCaptureResult>;
}

type Side = "base" | "head";
interface PartialNote {
  readonly reason: EvidencePartialReason;
  readonly detail: string;
}
type BuildGit = ReturnType<BeforeAfterContext["git"]>;

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/** `rel` under `root`, followed through links, is an existing directory inside it. */
const dirInside = (root: string, rel: string | undefined): string | null => {
  const abs = join(root, rel ?? "");
  try {
    const real = realpathSync(abs);
    return inside(realpathSync(root), real) && existsSync(real) ? abs : null;
  } catch {
    return null;
  }
};

const requestProblem = (r: BeforeAfterRequest): string | null => {
  if (!isAbsolute(r.repoRoot)) return "repoRoot is not absolute";
  if (!isAbsolute(r.outDir)) return "outDir is not absolute";
  if (!GitShaSchema.safeParse(r.base).success || !GitShaSchema.safeParse(r.head).success) {
    return "base and head must be full commit ids";
  }
  if (r.flowSeconds !== undefined) {
    const s = r.flowSeconds;
    if (!Number.isFinite(s) || s <= 0 || s > EVIDENCE_LIMITS.maxFlowSeconds) {
      return `flowSeconds is more than 0 and at most ${String(EVIDENCE_LIMITS.maxFlowSeconds)}`;
    }
  }
  return null;
};

/**
 * The gates that make a commit servable: every install-phase gate, then every unconditional L0
 * (build, typecheck) gate. A gate that needs a diff or runs only for some paths is a check.
 */
export const buildGatesOf = (config: GatesConfig): readonly Gate[] => [
  ...config.gates.filter((g) => g.phase === "install"),
  ...config.gates.filter(
    (g) =>
      g.phase === "verify" &&
      g.layer === "L0" &&
      g.when_changed === undefined &&
      !g.command.some((t) => t.includes("{changed}") || t.includes("{rules}")),
  ),
];

/** One planned before/after pair, and the flow recording on both sides. */
interface Plan {
  readonly before: EvidenceShot[];
  readonly after: EvidenceShot[];
  readonly schemes: Map<string, "light" | "dark">;
  readonly dropped: string[];
}

/**
 * The shots of both sides, numbered so a pair sorts together, within the PR's file budget (the
 * flow recordings keep their two places).
 */
export const planBeforeAfter = (
  jobs: readonly RenderJob[],
  appUrl: string,
  flowSeconds: number | undefined,
): Plan => {
  const prefix = new URL(appUrl).pathname.replace(/\/+$/, "");
  const flowFiles = flowSeconds === undefined ? 0 : 2;
  const pairs = Math.floor((EVIDENCE_LIMITS.maxFilesPerPr - flowFiles) / 2);
  const plan: Plan = { before: [], after: [], schemes: new Map(), dropped: [] };
  let n = 0;
  const nn = (): string => String((n += 1)).padStart(2, "0");
  jobs.forEach((job, i) => {
    const slug = `ui${String(i + 1)}-w${String(job.width)}-${job.theme}`;
    if (i >= pairs) {
      plan.dropped.push(slug);
      return;
    }
    const viewport = { width: job.width, height: UI_VIEWPORT_HEIGHT };
    const before = `${nn()}-${slug}-before.png`;
    const after = `${nn()}-${slug}-after.png`;
    plan.before.push({ name: before, kind: "ui_before", path: prefix + job.path, viewport });
    plan.after.push({ name: after, kind: "ui_after", path: prefix + job.path, viewport });
    plan.schemes.set(before, job.theme).set(after, job.theme);
  });
  const first = jobs[0];
  if (flowSeconds !== undefined && first !== undefined) {
    for (const [side, list] of [
      ["before", plan.before],
      ["after", plan.after],
    ] as const) {
      const name = `${nn()}-flow-${side}.webm`;
      list.push({
        name,
        kind: "flow_video",
        path: prefix + first.path,
        viewport: { ...EVIDENCE_VIDEO_SIZE },
        videoSeconds: flowSeconds,
      });
      plan.schemes.set(name, first.theme);
    }
  }
  return plan;
};

/** Runs the build gates in `checkout`; `null` when they all passed, else why not (no project text). */
const build = async (
  jail: GateCommandJail,
  gates: readonly Gate[],
  checkout: string,
  side: Side,
  commits: { readonly base: GitSha; readonly commit: GitSha },
  options: {
    readonly allowed: (argv: readonly string[]) => boolean;
    readonly env: Readonly<Record<string, string>>;
    readonly loopback: boolean;
    readonly logPrefix: string;
  },
): Promise<string | null> => {
  for (const [i, gate] of gates.entries()) {
    const which = `${gate.phase === "install" ? "install" : "build"} gate ${String(i + 1)} of ${String(gates.length)}`;
    if (!options.allowed(gate.command)) {
      return `its ${which} is not in this machine's gate allowlist (vtc calibrate)`;
    }
    const cwd = dirInside(checkout, gate.cwd);
    if (cwd === null) return `the working directory of its ${which} is not in the checkout`;
    const argv = gate.command.map((t) =>
      t.replaceAll("{base}", commits.base).replaceAll("{head}", commits.commit),
    );
    let exec;
    try {
      exec = await jail.run({
        phase: gate.phase,
        ...(options.loopback ? { loopback: true } : {}),
        checkout,
        argv,
        cwd,
        env: options.env,
        timeoutMs: gate.timeout_s * 1000,
        stdoutPath: `${options.logPrefix}/${side}-${String(i + 1)}.stdout.log`,
        stderrPath: `${options.logPrefix}/${side}-${String(i + 1)}.stderr.log`,
      });
    } catch {
      return `its ${which} could not start in the gate sandbox`;
    }
    if (exec.leftover !== undefined) {
      return `its ${which} left processes the gate sandbox could not confirm it stopped`;
    }
    if (exec.spawnError !== undefined) return `its ${which} could not start`;
    if (exec.timedOut) return `its ${which} timed out after ${String(gate.timeout_s)} s`;
    if (exec.code !== 0) {
      return `its ${which} failed (${exec.code === null ? "killed by a signal" : `exit ${String(exec.code)}`})`;
    }
  }
  return null;
};

/** The before/after capture (`EvidenceRecorder.captureBeforeAfter`); never throws. */
export const captureBeforeAfter = async (
  ctx: BeforeAfterContext,
  request: BeforeAfterRequest,
): Promise<BeforeAfterResult> => {
  const deny = [...new Set(request.denyText.map((v) => v.trim()).filter((v) => v !== ""))];
  const files: BeforeAfterResult["files"][number][] = [];
  const failed: BeforeAfterResult["failed"][number][] = [];
  let partial: PartialNote | null = null;
  // The first reason wins, except that a missing side says more than a missing shot.
  const note = (reason: EvidencePartialReason, detail: string): void => {
    if (partial === null || (partial.reason === "capture_failed" && reason !== "capture_failed")) {
      partial = { reason, detail: cleanReason(detail, deny) };
    }
  };
  const result = (): BeforeAfterResult => ({
    files,
    failed,
    ...(partial === null ? {} : { partial }),
  });
  const stop = (reason: EvidencePartialReason, detail: string): BeforeAfterResult => {
    note(reason, detail);
    return result();
  };

  const problem = requestProblem(request);
  if (problem !== null)
    return stop("capture_failed", `the before/after request is not valid: ${problem}`);

  let git: BuildGit;
  let config: GatesConfig;
  let screensText: string | null;
  try {
    git = ctx.git(request.repoRoot);
    const bytes = await git.readFileAtCommit(request.base, GATES_CONFIG_PATH);
    if (bytes === undefined) {
      return stop(
        "no_visual_app",
        "the base commit has no committed .vtc/gates.yml, so there is no visual.app to serve",
      );
    }
    try {
      config = parseGatesConfig(new TextDecoder().decode(bytes));
    } catch {
      return stop(
        "capture_failed",
        "the base commit's .vtc/gates.yml is not valid, so its visual.app and visual.redact_selectors are unknown",
      );
    }
    const screens =
      (await git.readFileAtCommit(request.base, DESIGN_SCREENS_PATH)) ??
      (await git.readFileAtCommit(request.head, DESIGN_SCREENS_PATH));
    screensText = screens === undefined ? null : new TextDecoder().decode(screens);
  } catch {
    return stop("capture_failed", "the commits could not be read from the project's repository");
  }
  if (!config.baseline.confirmed) {
    return stop(
      "capture_failed",
      "the base commit's .vtc/gates.yml is not confirmed (vtc calibrate), so nothing of it runs",
    );
  }
  const app = config.visual?.app;
  if (app === undefined) {
    return stop(
      "no_visual_app",
      "the committed .vtc/gates.yml has no visual.app to serve the UI from",
    );
  }
  const allowlist = readAllowlist(ctx.vtcHome, request.repoRoot);
  const allowed = (argv: readonly string[]): boolean => gateCommandAllowed(argv, allowlist);
  if (!allowed(app.command)) {
    return stop(
      "no_visual_app",
      "the committed visual.app command is not in this machine's gate allowlist (vtc calibrate asks a human to confirm it)",
    );
  }

  // Nothing is built for a capture that cannot happen.
  const browser = await ctx.browserProblem();
  if (browser !== null) return stop(browser.reason, browser.detail);
  const sandbox = ctx.sandbox();
  if (sandbox === null) {
    return stop(
      "capture_failed",
      "no gate sandbox on this machine (vtc doctor says why), so neither commit is built",
    );
  }
  // The Visual QA screens at the Visual QA widths and themes.
  if (screensText === null) {
    return stop(
      "capture_failed",
      `no committed ${DESIGN_SCREENS_PATH} names the screens to render`,
    );
  }
  let jobs: readonly RenderJob[];
  let missing: readonly string[];
  try {
    ({ jobs, missing } = expandMatrix(
      parseScreens(screensText),
      request.screens ?? [],
      visualConfigFor(config.visual),
    ));
  } catch {
    return stop(
      "capture_failed",
      `the committed ${DESIGN_SCREENS_PATH} is not a valid screen list`,
    );
  }
  if (jobs.length === 0) {
    return stop("capture_failed", `none of the requested screens is in ${DESIGN_SCREENS_PATH}`);
  }
  if (missing.length > 0) {
    note(
      "capture_failed",
      `${String(missing.length)} requested screen(s) are not in ${DESIGN_SCREENS_PATH}, so they were not captured`,
    );
  }
  const plan = planBeforeAfter(jobs, app.url, request.flowSeconds);
  for (const name of plan.dropped) failed.push({ name, reason: BEFORE_AFTER_FILE_LIMIT_REASON });

  const policy = gateReadPolicy({ vtcHome: ctx.vtcHome, env: ctx.env, repoRoot: request.repoRoot });
  const jail = new GateCommandJail(sandbox, policy.denyRead, policy);
  const gates = buildGatesOf(config);
  const origin = new URL(app.url).origin;
  const visual = {
    redact: config.visual?.redact_selectors ?? [],
    dynamic: config.visual?.dynamic_regions ?? [],
  };
  const logPrefix = join(
    request.repoRoot,
    BEFORE_AFTER_STATE_DIR,
    `${request.base.slice(0, 12)}-${request.head.slice(0, 12)}`,
  );
  let bytes = 0;

  const runSide = async (side: Side, commit: GitSha, shots: readonly EvidenceShot[]) => {
    const lost: EvidencePartialReason = side === "base" ? "base_build_failed" : "capture_failed";
    let rel: string;
    try {
      rel = await git.createCleanCheckout(commit);
    } catch {
      note(lost, `the clean gate checkout of the ${side} could not be made`);
      return;
    }
    try {
      const checkout = join(request.repoRoot, rel);
      const built = await build(
        jail,
        gates,
        checkout,
        side,
        { base: request.base, commit },
        {
          allowed,
          env: gateEnv(ctx.env),
          loopback: config.sandbox?.verify_loopback === true,
          logPrefix,
        },
      );
      if (built !== null) {
        note(lost, `the ${side} did not build: ${built}`);
        return;
      }
      const cwd = dirInside(checkout, app.cwd);
      const notServed: EvidencePartialReason =
        side === "base" ? "base_serve_failed" : "capture_failed";
      if (cwd === null) {
        note(notServed, `the ${side}'s visual.app working directory is not in its checkout`);
        return;
      }
      const captured = await ctx.capture(
        {
          origin,
          outDir: request.outDir,
          shots,
          redactSelectors: request.redactSelectors,
          denyText: deny,
        },
        {
          visual: () => visual,
          app: {
            command: app.command,
            cwd,
            url: app.url,
            readyTimeoutMs: app.ready_timeout_s * 1000,
            checkout,
          },
          jail,
          budgetBytes: EVIDENCE_LIMITS.maxBytesPerPr - bytes,
          colorSchemes: plan.schemes,
        },
      );
      for (const f of captured.files) bytes += f.bytes;
      files.push(...captured.files);
      failed.push(...captured.failed);
      if (captured.app === "failed") {
        note(
          notServed,
          `the ${side}'s app server did not serve: it did not start, did not answer in time or stopped during the capture`,
        );
      } else if (captured.failed.length > 0) {
        note(
          "capture_failed",
          `${String(captured.failed.length)} of the ${side}'s ${String(shots.length)} captures failed or were discarded by the redaction scan`,
        );
      }
    } catch {
      note(lost, `the ${side} could not be built and served`);
    } finally {
      await git.removeCheckout(rel).catch(() => undefined);
    }
  };

  try {
    await runSide("base", request.base, plan.before);
    await runSide("head", request.head, plan.after);
  } finally {
    jail.dispose();
  }
  // Pairs read in order: before, after, ..., then the flow recordings.
  files.sort((a, b) => a.name.localeCompare(b.name));
  return result();
};
