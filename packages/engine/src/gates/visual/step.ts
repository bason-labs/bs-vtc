/**
 * The deterministic visual step of one gate run (§7.5, §9.1; AD-24; D-ay). Order per AD-24
 * rule 3: token lint and the design detector on the changed UI source (no browser), then the
 * browser is resolved and re-verified against its pin, then the render matrix with axe, computed
 * styles and the per-region pixel diff runs in the gate sandbox. Returns the `VisualSummary`
 * for `GateReport.visual` and the evidence to write (the redacted `VisualReport` and the images).
 *
 * - No browser (neither the project's Playwright nor the doctor-installed store): `skipped` with
 *   `VISUAL_SKIPPED_NO_BROWSER`.
 * - The pin does not match, the runner failed, no app server is configured or allowed: `error`
 *   (gate infrastructure, §6.8).
 * - Settings come from `gates.yml` `visual` (`visualConfigFor`); `screens.yaml` and `tokens.json`
 *   are read at the base commit, so a diff cannot change what verifies it.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESIGN_SCREENS_PATH,
  VISUAL_SKIPPED_NO_BROWSER,
  visualConfigFor,
  type GateRunRequest,
  type GatesConfig,
  type GitChangedFile,
  type GitOps,
  type ToolFinding,
  type VisualSummary,
} from "@vtc/shared";
import type { PendingWrite } from "../evidence.js";
import { visualAppOf } from "./app.js";
import {
  checkProjectBrowser,
  checkStoreBrowser,
  chromiumOf,
  projectToolchain,
  storeToolchain,
  type BrowserCheck,
  type VisualToolchain,
} from "./browser.js";
import { detectorFindings, type DetectorFile } from "./detector/index.js";
import { addedLinesWithNumbers } from "./diff-lines.js";
import {
  evaluateVisual,
  visualWithoutRenders,
  type BrowserIdentity,
  type VisualOutcome,
} from "./evaluate.js";
import { expandMatrix, parseScreens, type RenderMatrix } from "./matrix.js";
import { RunnerResultSchema, STYLE_PROPERTIES, type RunnerInput } from "./protocol.js";
import type { VisualRunner } from "./runner.js";
import { isUiSource, tokenLint } from "./token-lint.js";
import { DESIGN_TOKENS_PATH, parseDesignTokens, type DesignTokens } from "./tokens.js";

/** The approved prototype in the checkout (`ENGINE_HTTP.prototype.root`). */
export const PROTOTYPE_DIR = ".vtc/design/prototype";
/** The fixed clock of every render (§7.5 determinism). */
export const VISUAL_FIXED_TIME = "2026-01-15T12:00:00.000Z";
const STYLE_LIMIT = 400;
const NAV_TIMEOUT_MS = 30_000;
const MAX_DETECTOR_BYTES = 2 * 1024 * 1024;

export interface VisualToolchains {
  readonly project: (
    checkoutAbs: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => VisualToolchain | null;
  readonly store: (vtcHome: string) => VisualToolchain | null;
}

export const DEFAULT_TOOLCHAINS: VisualToolchains = {
  project: projectToolchain,
  store: storeToolchain,
};

export interface VisualStepContext {
  readonly request: Pick<GateRunRequest, "run" | "task" | "feature" | "base" | "head" | "visual">;
  readonly repoRoot: string;
  readonly vtcHome: string;
  readonly checkoutAbs: string;
  readonly git: Pick<GitOps, "diff" | "readFileAtCommit">;
  readonly changed: readonly GitChangedFile[];
  readonly config: GatesConfig;
  /** The raw `gates.yml` the run started with (for the provisional `visual.app`). */
  readonly gatesYml: string | null;
  /** The engine's environment (to find the project's Playwright cache). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The scrubbed gate environment the runner gets (`gateEnv`). */
  readonly gateEnv: Readonly<Record<string, string>>;
  readonly runner: VisualRunner;
  /** Whether an argv passes the machine's gate allowlist (§15). */
  readonly allowCommand: (argv: readonly string[]) => boolean;
  /** Repo-relative directory the visual evidence goes to. */
  readonly evidenceDir: string;
  /** Absolute prefix of the runner's raw logs under `.vtc/state/`. */
  readonly logPrefix: string;
  readonly toolchains?: VisualToolchains;
  readonly now: () => Date;
}

export interface VisualStepResult {
  readonly summary: VisualSummary;
  readonly writes: readonly PendingWrite[];
}

const decode = (bytes: Uint8Array | undefined): string | null =>
  bytes === undefined ? null : new TextDecoder().decode(bytes);

/** SHA-256 over the prototype's files (paths and bytes), the render cache's source input. */
export const prototypeHash = (dir: string): string => {
  const hash = createHash("sha256");
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
      else if (entry.isFile()) {
        hash.update(`${childRel}\u0000`);
        hash.update(readFileSync(join(abs, entry.name)));
        hash.update("\u0000");
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
};

const isDir = (abs: string): boolean => {
  try {
    return lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
};

export const runVisualStep = async (ctx: VisualStepContext): Promise<VisualStepResult> => {
  const { request } = ctx;
  const settings = visualConfigFor(ctx.config.visual);
  const reportPath = `${ctx.evidenceDir}/report.json`;
  const writtenAt = ctx.now().toISOString();
  const toolchains = ctx.toolchains ?? DEFAULT_TOOLCHAINS;
  const notRun: string[] = [];

  // 1. token lint and the detector: changed UI source, no browser.
  const ui = ctx.changed.filter((f) => f.status !== "deleted" && isUiSource(f.path));
  const tokensText = decode(await ctx.git.readFileAtCommit(request.base, DESIGN_TOKENS_PATH));
  const tokens: DesignTokens | null = tokensText === null ? null : parseDesignTokens(tokensText);
  if (tokens === null) {
    notRun.push(
      `${DESIGN_TOKENS_PATH} is not committed at the base: token lint and computed styles not checked`,
    );
  }
  let lint: ToolFinding[] = [];
  if (ui.length > 0 && tokens !== null && request.base !== request.head) {
    const diff = await ctx.git.diff(
      request.base,
      request.head,
      ui.map((f) => f.path),
    );
    lint = tokenLint(addedLinesWithNumbers(diff), tokens, { colorDelta: settings.color_delta });
  }
  const files: DetectorFile[] = [];
  for (const f of ui) {
    // The commit's bytes, not the checkout's: earlier gates ran project code in the checkout.
    const bytes = await ctx.git.readFileAtCommit(request.head, f.path);
    if (bytes === undefined || bytes.length > MAX_DETECTOR_BYTES) continue;
    const head = new TextDecoder().decode(bytes);
    const base =
      request.base === request.head
        ? undefined
        : (decode(await ctx.git.readFileAtCommit(request.base, f.oldPath ?? f.path)) ?? undefined);
    files.push({ path: f.path, head, base });
  }
  const detector = detectorFindings(files);
  const staticFindings = [...lint, ...detector];
  const staticCounts = { token_lint: lint.length, detector: detector.length };

  const finish = (outcome: VisualOutcome, images: PendingWrite[] = []): VisualStepResult => ({
    summary: outcome.summary,
    writes: [{ rel: reportPath, redact: true, json: outcome.report }, ...images],
  });
  const without = (
    status: "skipped" | "error",
    reason: string,
    browser: BrowserIdentity | null = null,
  ) =>
    finish(
      visualWithoutRenders({
        run: request.run,
        task: request.task,
        feature: request.feature,
        status,
        reason,
        browser,
        findings: staticFindings,
        reportPath,
        writtenAt,
        counts: staticCounts,
      }),
    );

  // 2. the render matrix from screens.yaml at the base commit.
  let matrix: RenderMatrix = { jobs: [], missing: [] };
  const screensText = decode(await ctx.git.readFileAtCommit(request.base, DESIGN_SCREENS_PATH));
  if (screensText === null) notRun.push(`${DESIGN_SCREENS_PATH} is not committed at the base`);
  else {
    try {
      matrix = expandMatrix(parseScreens(screensText), request.visual?.screens ?? [], settings);
    } catch (error) {
      notRun.push(
        `${DESIGN_SCREENS_PATH} is not a valid screen list: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 3. the browser: the project's own, else the doctor-installed store, re-verified (rule 2).
  const browsersEnv = (toolchain: VisualToolchain): Record<string, string> => ({
    ...ctx.gateEnv,
    PLAYWRIGHT_BROWSERS_PATH: toolchain.browsersPath,
  });
  const baseInput = {
    v: 1 as const,
    axe_tags: settings.axe_tags,
    include_best_practice: settings.include_best_practice,
    pixel_threshold: settings.pixel_threshold,
    dynamic_regions: settings.dynamic_regions,
    style_properties: [...STYLE_PROPERTIES],
    style_limit: STYLE_LIMIT,
    nav_timeout_ms: NAV_TIMEOUT_MS,
    fixed_time: VISUAL_FIXED_TIME,
  };
  let toolchain: VisualToolchain | null = null;
  let check: BrowserCheck | null = null;
  const notes: string[] = [];
  const project = toolchains.project(ctx.checkoutAbs, ctx.env);
  if (project !== null) {
    const probe = await ctx.runner.run({
      input: {
        ...baseInput,
        mode: "probe",
        playwright: project.playwright,
        executable: null,
        axe: null,
        pixelmatch: null,
        prototype_root: null,
        app: null,
        jobs: [],
      },
      allowRead: project.readable,
      loopback: false,
      env: browsersEnv(project),
      checkout: ctx.checkoutAbs,
      timeoutMs: 60_000,
      stdoutPath: `${ctx.logPrefix}.probe.stdout.log`,
      stderrPath: `${ctx.logPrefix}.probe.stderr.log`,
    });
    if (probe.ok && probe.result.executable !== undefined) {
      const chromium = chromiumOf(project.playwright);
      check = await checkProjectBrowser({
        vtcHome: ctx.vtcHome,
        repoRoot: ctx.repoRoot,
        executable: probe.result.executable,
        browsersPath: project.browsersPath,
        name: chromium.name,
        version: chromium.version,
        playwrightVersion: project.playwrightVersion,
        now: ctx.now(),
      });
      if (check !== null) toolchain = project;
      else notes.push(`the project's Playwright has no browser at ${probe.result.executable}`);
    } else {
      notes.push(
        `the project's Playwright could not be probed: ${probe.ok ? (probe.result.error ?? "no executable") : probe.reason}`,
      );
    }
  }
  if (toolchain === null) {
    const store = toolchains.store(ctx.vtcHome);
    if (store !== null) {
      check = await checkStoreBrowser(ctx.vtcHome);
      if (check !== null) toolchain = store;
    }
  }
  if (toolchain === null || check === null) {
    const why = notes.length > 0 ? ` (${notes.join("; ")})` : "";
    return without("skipped", `${VISUAL_SKIPPED_NO_BROWSER}${why}`.slice(0, 500));
  }
  if (!check.ok) return without("error", check.reason);
  const pin = check.pin;
  const browser: BrowserIdentity = {
    name: pin.name,
    version: pin.version,
    executable_sha256: pin.executable_sha256,
  };

  // 4. the app server (provisional `visual.app`, allowlisted like a gate).
  const app = visualAppOf(ctx.gatesYml);
  if (app === null) {
    return without(
      "error",
      "no app server for the visual step: add visual.app (command, loopback url) to .vtc/gates.yml with vtc calibrate",
      browser,
    );
  }
  if ("invalid" in app) return without("error", `gates.yml ${app.invalid}`, browser);
  if (!ctx.allowCommand(app.command)) {
    return without(
      "error",
      `the visual app server [${app.command.join(" ")}] is not in this machine's gate allowlist; a human confirms it with vtc calibrate (§15)`,
      browser,
    );
  }

  // 5. the render matrix in the gate sandbox.
  if (toolchain.axe === null)
    notRun.push("axe-core is not installed in the project or the browser store");
  if (toolchain.pixelmatch === null) {
    notRun.push("pixelmatch is not installed in the project or the browser store");
  }
  const prototypeAbs = join(ctx.checkoutAbs, PROTOTYPE_DIR);
  const hasPrototype = isDir(prototypeAbs);
  const protoHash = hasPrototype ? prototypeHash(prototypeAbs) : "none";
  const sourceHash = (key: string): string =>
    createHash("sha256")
      .update(`${request.head}\u0000${pin.executable_sha256}\u0000${protoHash}\u0000${key}`)
      .digest("hex");
  let result = RunnerResultSchema.parse({ v: 1 });
  let file: (name: string) => Uint8Array | null = () => null;
  if (matrix.jobs.length > 0) {
    const input: Omit<RunnerInput, "out_dir"> = {
      ...baseInput,
      mode: "render",
      playwright: toolchain.playwright,
      executable: pin.executable,
      axe: toolchain.axe,
      pixelmatch: toolchain.pixelmatch,
      prototype_root: hasPrototype ? prototypeAbs : null,
      app: {
        command: app.command,
        cwd: join(ctx.checkoutAbs, app.cwd ?? ""),
        url: app.url,
        ready_timeout_ms: app.ready_timeout_s * 1000,
      },
      jobs: matrix.jobs.map((j) => ({ key: j.key, path: j.path, width: j.width, theme: j.theme })),
    };
    const outcome = await ctx.runner.run({
      input,
      allowRead: toolchain.readable,
      loopback: true,
      env: browsersEnv(toolchain),
      checkout: ctx.checkoutAbs,
      timeoutMs: Math.min(
        7_200_000,
        120_000 + app.ready_timeout_s * 1000 + matrix.jobs.length * 30_000,
      ),
      stdoutPath: `${ctx.logPrefix}.stdout.log`,
      stderrPath: `${ctx.logPrefix}.stderr.log`,
    });
    if (!outcome.ok) return without("error", outcome.reason, browser);
    result = outcome.result;
    file = outcome.file;
  }

  // 6. images into evidence, then the verdict.
  const images: PendingWrite[] = [];
  const copied = new Set<string>();
  const evidencePath = (name: string): string => `${ctx.evidenceDir}/${name}`;
  const copy = (name: string | undefined): string | undefined => {
    if (name === undefined) return undefined;
    if (!copied.has(name)) {
      const bytes = file(name);
      if (bytes === null) return undefined;
      images.push({ rel: evidencePath(name), redact: false, bytes });
      copied.add(name);
    }
    return name;
  };
  const renders = result.renders.map((r) => {
    const screenshot = copy(r.screenshot);
    const reference =
      r.reference === undefined
        ? undefined
        : { ...r.reference, screenshot: copy(r.reference.screenshot) };
    return {
      ...r,
      screenshot,
      ...(reference === undefined ? {} : { reference }),
      diffs: r.diffs.map((d) => ({ ...d, diff_image: copy(d.diff_image) })),
    };
  });
  const cleaned = RunnerResultSchema.parse(JSON.parse(JSON.stringify({ ...result, renders })));
  const outcome = evaluateVisual({
    run: request.run,
    task: request.task,
    feature: request.feature,
    settings,
    tokens,
    jobs: matrix.jobs,
    missingScreens: matrix.missing,
    result: cleaned,
    browser,
    sourceHash,
    evidencePath,
    tokenLint: lint,
    detector,
    notRun,
    reportPath,
    writtenAt,
  });
  return finish(outcome, images);
};
