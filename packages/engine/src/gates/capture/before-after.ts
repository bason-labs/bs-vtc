/**
 * UI before/after evidence for an automatic PR (D-ct; spine §5 reading 223;
 * `EvidenceRecorder.captureBeforeAfter`): for the base and then the head, a clean gate checkout of
 * that commit (never the user's work tree), its install-phase gates and its unconditional L0
 * build gates in the gate sandbox, then the app server of the project's committed `gates.yml`
 * (`visual.app`, read at the base like every gate) served in that checkout by the evidence runner,
 * which renders the Visual QA screens (`screens.yaml`, or the request's `screens`) at the Visual
 * QA widths and themes (`visualConfigFor`) and, with `flowSeconds`, records a flow video.
 * Build time, no AI tokens; nothing is downloaded at capture time.
 *
 * - Git: only the engine's `GitOps` the cli injects (AD-13 rule 4), over the recorder's own
 *   `repoRoot`; a request for another repository, or a recorder without either, captures nothing.
 * - Sandbox: each side gets a gate sandbox jail of its own (its own `HOME` and temp directories,
 *   removed before the next side starts), so nothing one commit's code leaves behind reaches the
 *   other. Never unconfined: `gates.allow_unsandboxed` does not apply, since the commits are built
 *   and served only for evidence. On a Linux host whose ptrace policy is open, nothing is built
 *   (`EVIDENCE_PTRACE_REFUSAL`).
 *
 * - Commands: only what this machine's gate allowlist confirms (§15): the build gates and
 *   `visual.app.command`. A gate that needs a diff (`{changed}`, `{rules}`), only runs when some
 *   paths change (`when_changed`) or runs a pinned scanner is a check, not a build, and does not
 *   run here.
 * - Redaction: every frame passes the same layers as `capture` (the request's `redactSelectors`,
 *   VTC's defaults and the committed `visual.redact_selectors` painted and masked,
 *   `visual.dynamic_regions` masked, the text scan against `SECRET_PATTERNS` and `denyText`, fail
 *   closed).
 * - Names and budget: `NN-ui<k>-w<width>-<theme>-before|after.png` (`ui_before` / `ui_after`) and
 *   `NN-flow-before|after.webm` (`flow_video`), numbered so each pair sorts together; neutral, with
 *   no project text. At most `EVIDENCE_LIMITS.maxFilesPerPr` files and `maxBytesPerPr` bytes in
 *   all, the base at most half of the bytes so the head's "after" files always have room:
 *   renders past the file budget are left out and listed in `failed`
 *   ({@link BEFORE_AFTER_FILE_LIMIT_REASON}).
 * - Flow video (D-ct; spine §5 reading 247(7)): with `flow`, each side reads that flow from its
 *   own commit's `.vtc/design/flows.yaml` (`DesignFlowsFileSchema`) and its `flow_video` starts at
 *   the flow's `start` route and runs its steps while it records, all within `flowSeconds`
 *   (`EvidenceRunnerShot.flow`: goto, click, fill from the file's named fixture, press, wait for,
 *   wait), every frame redacted and scanned like any other. `BeforeAfterResult.flow` says per
 *   side what the video shows: `scripted` (every step ran), `idle` (that commit has no such flow,
 *   or no readable flows file, so its first rendered screen was recorded as without a flow) or
 *   `failed` (a step failed or ran out of time, and the recording up to it is kept; or the side
 *   recorded nothing). Without `flow`, each side records the first rendered screen (the first job
 *   of the matrix) loading and then left idle for `flowSeconds`, with reduced motion and no
 *   interaction; without `flowSeconds`, no video and no `flow` in the result.
 * - Partial: whatever was captured is returned, with `partial` when a side or a shot is missing:
 *   `base_build_failed` / `base_serve_failed` for the base, `no_visual_app`, `no_browser`, and
 *   `capture_failed` for everything else (the head, a discarded or failed shot, a bad request).
 *   Every detail is VTC's own fixed text with no project text in it (no gate ids, commands, paths
 *   or app output).
 * - Build logs stay local under `.vtc/state/gates/before-after/<base>-<head>-<unique>/` (AD-18),
 *   made without following links; only the newest {@link BEFORE_AFTER_LOGS_KEPT} are kept.
 * - Known limit (macOS): the app's port is checked free before it starts, but the check and the
 *   bind are not atomic on the shared host loopback (`script.ts`).
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parse } from "yaml";
import {
  DESIGN_FLOWS_PATH,
  DESIGN_SCREENS_PATH,
  DesignFlowsFileSchema,
  EVIDENCE_LIMITS,
  gateCommandAllowed,
  GitShaSchema,
  parsePersisted,
  SlugSchema,
  visualConfigFor,
  type BeforeAfterRequest,
  type BeforeAfterResult,
  type DesignFlow,
  type EvidenceCaptureRequest,
  type EvidencePartialReason,
  type EvidenceShot,
  type Gate,
  type GatesConfig,
  type GateSandbox,
  type GitOps,
  type GitSha,
} from "@vtc/shared";
import { ensureRepoDir } from "../../git/index.js";
import { GATES_CONFIG_PATH, parseGatesConfig, readAllowlist } from "../config.js";
import { GATES_STATE_DIR } from "../evidence.js";
import { gateEnv } from "../exec.js";
import { GateCommandJail, gateReadPolicy } from "../sandbox.js";
import { SCANNER_PINS } from "../scanner-pins.js";
import { expandMatrix, parseScreens, type RenderJob } from "../visual/matrix.js";
import { cleanReason } from "./clean.js";
import {
  EVIDENCE_VIDEO_SIZE,
  UI_VIEWPORT_HEIGHT,
  type EvidenceRunnerFlowStep,
} from "./protocol.js";
import type { CaptureTarget, TargetCaptureResult } from "./target.js";

/** Why a render was left out: one PR carries at most `maxFilesPerPr` evidence files. */
export const BEFORE_AFTER_FILE_LIMIT_REASON = `left out: a PR carries at most ${String(EVIDENCE_LIMITS.maxFilesPerPr)} evidence files; name fewer screens to capture this one`;
/** Where the raw output of the base and head builds stays (gitignored, never evidence). */
export const BEFORE_AFTER_STATE_DIR = `${GATES_STATE_DIR}/before-after`;
/** How many captures' build logs are kept under {@link BEFORE_AFTER_STATE_DIR}. */
export const BEFORE_AFTER_LOGS_KEPT = 10;
/** Why nothing is built when the only sandbox is the unconfined opt-in. */
export const BEFORE_AFTER_NO_UNSANDBOXED =
  "no gate sandbox on this machine (vtc doctor says why), and gates.allow_unsandboxed does not apply to evidence: the commits are built and served only for evidence, never unconfined, so neither is built";
/** Why nothing is built for a request about another repository. */
export const BEFORE_AFTER_OTHER_REPO =
  "the before/after request names another repository than the one this evidence recorder captures for";

/** What the before/after capture needs from the recorder that owns it. */
export interface BeforeAfterContext {
  readonly vtcHome: string;
  /** The project the recorder captures for; absent: nothing is built. */
  readonly repoRoot: string | undefined;
  /** The engine's environment, scrubbed (`gateEnv`) before any command sees it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The gate sandbox (D-al), or `null`: nothing is built; nor with the unconfined opt-in. */
  readonly sandbox: () => GateSandbox | null;
  /** The engine's injected git over `repoRoot` (AD-13 rule 4); absent: nothing is built. */
  readonly git:
    Pick<GitOps, "readFileAtCommit" | "createCleanCheckout" | "removeCheckout"> | undefined;
  /** Why this host cannot serve an app beside the runner (Linux ptrace policy), or `null`. */
  readonly hostProblem: () => string | null;
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
  if (r.flow !== undefined && !SlugSchema.safeParse(r.flow).success) {
    return "flow is not a flow id (a slug)";
  }
  return null;
};

/** The path under which the app serves its routes: the app URL's own path, no trailing `/`. */
const appPrefix = (appUrl: string): string => new URL(appUrl).pathname.replace(/\/+$/, "");

/** A side's flow (D-ct): the named flow of that commit's own flows file, or `null` (idle). */
export const sideFlow = (
  text: string | null,
  id: string,
): { readonly flow: DesignFlow; readonly fixtures: Readonly<Record<string, string>> } | null => {
  if (text === null) return null;
  try {
    const parsed = parsePersisted(DesignFlowsFileSchema, parse(text, { uniqueKeys: true }));
    if (!parsed.success) return null;
    const flow = parsed.data.flows.find((f) => f.id === id);
    return flow === undefined ? null : { flow, fixtures: parsed.data.fixtures };
  } catch {
    return null;
  }
};

/** The runner's steps of a flow: `goto` paths under the app's path, `fill` values from the fixtures. */
export const flowSteps = (
  flow: DesignFlow,
  fixtures: Readonly<Record<string, string>>,
  prefix: string,
): EvidenceRunnerFlowStep[] =>
  flow.steps.map((step): EvidenceRunnerFlowStep => {
    switch (step.action) {
      case "goto":
        return { action: "goto", path: prefix + step.route };
      case "fill":
        return { action: "fill", selector: step.selector, value: fixtures[step.fixture] ?? "" };
      default:
        return step;
    }
  });

/** Both paths name the same existing directory. */
const sameDir = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

const PINNED_SCANNERS: readonly string[] = SCANNER_PINS.scanners.map((s) => s.name);

/**
 * The gates that make a commit servable: every install-phase gate, then every unconditional L0
 * (build, typecheck) gate. A gate that needs a diff, runs only for some paths or runs a pinned
 * scanner is a check.
 */
export const buildGatesOf = (
  config: GatesConfig,
  scanners: readonly string[] = PINNED_SCANNERS,
): readonly Gate[] => [
  ...config.gates.filter((g) => g.phase === "install"),
  ...config.gates.filter(
    (g) =>
      g.phase === "verify" &&
      g.layer === "L0" &&
      g.when_changed === undefined &&
      !scanners.includes(g.command[0] ?? "") &&
      !g.command.some((t) => t.includes("{changed}") || t.includes("{rules}")),
  ),
];

/**
 * A fresh build-log directory of one capture under {@link BEFORE_AFTER_STATE_DIR}, made without
 * following links, after the oldest beyond {@link BEFORE_AFTER_LOGS_KEPT} are removed.
 */
const newLogDir = (repoRoot: string, base: GitSha, head: GitSha): string => {
  const unique = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const rel = `${BEFORE_AFTER_STATE_DIR}/${base.slice(0, 12)}-${head.slice(0, 12)}-${unique}`;
  ensureRepoDir(repoRoot, BEFORE_AFTER_STATE_DIR);
  const parent = join(repoRoot, BEFORE_AFTER_STATE_DIR);
  try {
    const old = readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ path: join(parent, e.name), at: lstatSync(join(parent, e.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(BEFORE_AFTER_LOGS_KEPT - 1);
    for (const dir of old) rmSync(dir.path, { recursive: true, force: true });
  } catch {
    // best effort: old logs only take space
  }
  ensureRepoDir(repoRoot, rel);
  return join(repoRoot, rel);
};

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
  const prefix = appPrefix(appUrl);
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
  let flowResult: BeforeAfterResult["flow"] | undefined;
  const result = (): BeforeAfterResult => ({
    files,
    failed,
    ...(partial === null ? {} : { partial }),
    ...(flowResult === undefined ? {} : { flow: flowResult }),
  });
  const stop = (reason: EvidencePartialReason, detail: string): BeforeAfterResult => {
    note(reason, detail);
    return result();
  };

  const problem = requestProblem(request);
  if (problem !== null)
    return stop("capture_failed", `the before/after request is not valid: ${problem}`);
  const { git, repoRoot } = ctx;
  if (git === undefined || repoRoot === undefined) {
    return stop(
      "capture_failed",
      "this evidence recorder has no project repository and git (the cli injects both), so nothing is built",
    );
  }
  if (!sameDir(repoRoot, request.repoRoot)) return stop("capture_failed", BEFORE_AFTER_OTHER_REPO);

  let config: GatesConfig;
  let screensText: string | null;
  const flowTexts: Record<Side, string | null> = { base: null, head: null };
  try {
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
    if (request.flow !== undefined && request.flowSeconds !== undefined) {
      // Each side scripts the flow from its own commit's flows file.
      for (const [side, commit] of [
        ["base", request.base],
        ["head", request.head],
      ] as const) {
        const flows = await git.readFileAtCommit(commit, DESIGN_FLOWS_PATH);
        flowTexts[side] = flows === undefined ? null : new TextDecoder().decode(flows);
      }
    }
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
  const allowlist = readAllowlist(ctx.vtcHome, repoRoot);
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
  const host = ctx.hostProblem();
  if (host !== null) return stop("capture_failed", host);
  const sandbox = ctx.sandbox();
  if (sandbox === null) {
    return stop(
      "capture_failed",
      "no gate sandbox on this machine (vtc doctor says why), so neither commit is built",
    );
  }
  // The unconfined opt-in is for a project's own gates, never for building commits as evidence.
  if (sandbox.kind === "none") return stop("capture_failed", BEFORE_AFTER_NO_UNSANDBOXED);
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
  // The flow each side scripts (D-ct): `null` records the first screen idle, as without a flow.
  const flowId = request.flowSeconds === undefined ? undefined : request.flow;
  const scripts: Record<Side, ReturnType<typeof sideFlow>> = {
    base: flowId === undefined ? null : sideFlow(flowTexts.base, flowId),
    head: flowId === undefined ? null : sideFlow(flowTexts.head, flowId),
  };
  const flowStatus: Record<Side, "scripted" | "idle" | "failed"> = {
    base: scripts.base === null ? "idle" : "failed",
    head: scripts.head === null ? "idle" : "failed",
  };

  const policy = gateReadPolicy({ vtcHome: ctx.vtcHome, env: ctx.env, repoRoot });
  const gates = buildGatesOf(config);
  const origin = new URL(app.url).origin;
  const visual = {
    redact: config.visual?.redact_selectors ?? [],
    dynamic: config.visual?.dynamic_regions ?? [],
  };
  let logPrefix: string;
  try {
    logPrefix = newLogDir(repoRoot, request.base, request.head);
  } catch {
    return stop(
      "capture_failed",
      `the build log directory ${BEFORE_AFTER_STATE_DIR} could not be made (a link or a file is in its way)`,
    );
  }
  let bytes = 0;

  const runSide = async (
    side: Side,
    commit: GitSha,
    shots: readonly EvidenceShot[],
    budgetBytes: number,
  ) => {
    const lost: EvidencePartialReason = side === "base" ? "base_build_failed" : "capture_failed";
    let rel: string;
    try {
      rel = await git.createCleanCheckout(commit);
    } catch {
      note(lost, `the clean gate checkout of the ${side} could not be made`);
      return;
    }
    // A jail of the side's own: nothing the other commit's code left in HOME or a temp directory.
    const jail = new GateCommandJail(sandbox, policy.denyRead, policy);
    try {
      const checkout = join(repoRoot, rel);
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
      // A scripted side's recording starts at its flow's start route and runs its steps.
      const script = scripts[side];
      const prefix = appPrefix(app.url);
      const recordings = shots.filter((s) => s.kind === "flow_video").map((s) => s.name);
      const sideShots =
        script === null
          ? shots
          : shots.map((s) =>
              s.kind === "flow_video" ? { ...s, path: prefix + script.flow.start } : s,
            );
      const flows =
        script === null
          ? undefined
          : new Map(
              recordings.map((name) => [
                name,
                { steps: flowSteps(script.flow, script.fixtures, prefix) },
              ]),
            );
      const captured = await ctx.capture(
        {
          origin,
          outDir: request.outDir,
          shots: sideShots,
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
          budgetBytes,
          colorSchemes: plan.schemes,
          ...(flows === undefined ? {} : { flows }),
        },
      );
      for (const f of captured.files) bytes += f.bytes;
      if (script !== null) {
        // Scripted only when every step ran and the recording was kept.
        const kept = new Set(captured.files.map((f) => f.name));
        flowStatus[side] = recordings.every(
          (name) => kept.has(name) && captured.flows?.get(name) === "scripted",
        )
          ? "scripted"
          : "failed";
      }
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
      jail.dispose();
      await git.removeCheckout(rel).catch(() => undefined);
    }
  };

  // The base gets at most half of the bytes: the head's "after" files matter more.
  await runSide("base", request.base, plan.before, Math.floor(EVIDENCE_LIMITS.maxBytesPerPr / 2));
  await runSide("head", request.head, plan.after, EVIDENCE_LIMITS.maxBytesPerPr - bytes);
  // Pairs read in order: before, after, ..., then the flow recordings.
  files.sort((a, b) => a.name.localeCompare(b.name));
  if (flowId !== undefined && plan.before.some((s) => s.kind === "flow_video")) {
    flowResult = { id: flowId, before: flowStatus.base, after: flowStatus.head };
  }
  return result();
};
