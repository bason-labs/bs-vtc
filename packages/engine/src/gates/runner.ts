/**
 * The Gate Runner (§6.3 step 5, §7.2, AD-13): runs the calibrated gates of `.vtc/gates.yml` on the
 * clean verification checkout engine core made, returns one `GateReport`, and never throws for a
 * failing gate (failures, infrastructure errors and timeouts are results).
 *
 * - Only commands the human confirmed (`~/.vtc/allowlists/<repo-key>.json`) or pinned scanners
 *   run (§15, AD-13 rule 10); anything else reports `error` / `infra` and is not started.
 * - Only new problems block (§7.1): test failures and findings that also occur on the base commit
 *   are baseline violations, found by running the same gate on a clean checkout of the base.
 * - Hidden acceptance tests are copied in only for `include_hidden` runs and never reach evidence.
 * - Evidence is written redacted under `.vtc/evidence/<T-n|F-n>/`; raw output stays under
 *   `.vtc/state/gates/` (AD-18).
 * - The gates are the base commit's `.vtc/gates.yml`, never the working tree's, so a run is
 *   reproducible and a diff cannot change the gates that verify it.
 * - Every command runs in the gate sandbox (D-al, spine §5 reading 69, `sandbox.ts`): no network
 *   in the verify phase, writes only to the checkout and private temp dirs, the VTC home and host
 *   credentials unreadable, an empty `HOME`. Without one nothing runs (`GATE_SANDBOX
 *   .noSandboxReason`), unless the user opted in with `gates.allow_unsandboxed`.
 * - Nothing an earlier gate wrote in the checkout feeds a later verifying gate (spine §5 reading
 *   80): pinned scanners run in a clean checkout of their own (head, and base for the baseline),
 *   and L1 runs after every file it guards was put back to the head commit.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  engineRepoKey,
  fingerprintFinding,
  GATE_SANDBOX,
  gateCommandAllowed,
  gateReportVerdict,
  GateReportSchema,
  GateRunRequestSchema,
  HIDDEN_TESTS,
  TestInventorySchema,
  isAtLeast,
  normalizeSeverity,
  redactJson,
  redactSecrets,
  type Evidence,
  type FailureClass,
  type Gate,
  type GateLayer,
  type GateReport,
  type GateResult,
  type GateRunner,
  type GateRunnerDeps,
  type GateRunRequest,
  type GateSandbox,
  type GatesConfig,
  type GitChangedFile,
  type MonotonicViolation,
  type TestInventory,
  type TestMetrics,
  type TestRecord,
  type ToolFinding,
  type VisualSummary,
  type WriteScopeCheckRequest,
} from "@vtc/shared";
import { assertNoSymlinks, ensureRepoDir, removeRepoFile, writeRepoFile } from "../git/index.js";
import { compiledL6 } from "./arch/index.js";
import { classifyFailure, environmentSignatureLine } from "./classify.js";
import { GATES_CONFIG_PATH, loadGatesConfig, parseGatesConfig, readAllowlist } from "./config.js";
import {
  attemptId,
  EVIDENCE_DIR,
  flushWrites,
  GATES_STATE_DIR,
  knownSecretValues,
  toJunitXml,
  traceabilityPath,
  type PendingWrite,
} from "./evidence.js";
import { gateEnv, type ExecResult } from "./exec.js";
import { matchesAny, matchesAnyCaseless } from "./globs.js";
import { countsOf, inventoryOf, monotonicViolations } from "./metrics.js";
import { guardedSections, isMixedConfig, withBaseSections } from "./mixed-configs.js";
import { diffCoveragePct, parseJsonFindings } from "./parsers/json-reports.js";
import { parseJunit, type JunitCase } from "./parsers/junit.js";
import { isSarif, parseSarif } from "./parsers/sarif.js";
import type { ParsedFinding } from "./parsers/types.js";
import {
  DEFAULT_PROTECTED_GLOBS,
  isGateCommandFile,
  SCANNER_CONFIG_GLOBS,
} from "./protected-globs.js";
import { ensureRules } from "./rules.js";
import { OSV_DB_ENV, osvDatabaseDir, osvDatabaseReady } from "./osv-db.js";
import { checkScannerArgs, scannerExtraArgs } from "./scanner-args.js";
import {
  createScannerStore,
  findUserInstalled,
  ScannerUnavailableError,
  USER_INSTALLED_SCANNERS,
  type ScannerStore,
} from "./scanners.js";
import {
  detectGateSandbox,
  GateCommandJail,
  gateReadPolicy,
  resolveGateSandbox,
  type JailedResult,
} from "./sandbox.js";
import { computeScopeCreep, scopeCreepFindings, type ScopeCreep } from "./scope-creep.js";
import { buildTraceability } from "./traceability.js";
import { visualWithoutRenders } from "./visual/evaluate.js";
import { noveltySeam } from "./visual/novelty.js";
import {
  engineNodeExecutable,
  resolveNodeExecutable,
  sandboxedVisualRunner,
  type VisualRunner,
} from "./visual/runner.js";
import { runVisualStep, type VisualToolchains } from "./visual/step.js";
import { checkWriteScope } from "./write-scope.js";

export interface GateRunnerOptions {
  /** The pinned scanner store; default: the embedded pins under `deps.vtcHome`. */
  readonly scanners?: ScannerStore;
  /** The engine's environment, scrubbed before any gate sees it (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Finds the machine's gate sandbox when `deps.sandbox` is absent (default
   * {@link detectGateSandbox}). Tests pass `() => null` to stand for a machine without one.
   */
  readonly detectSandbox?: () => GateSandbox | null;
  /**
   * Runs the visual runner script (AD-24); default: in the gate sandbox with {@link node}.
   * Tests inject a fake and never start a browser.
   */
  readonly visualRunner?: VisualRunner;
  /** Where the visual step finds Playwright (default: the browser store, then the project's). */
  readonly visualToolchains?: VisualToolchains;
  /**
   * The absolute Node the visual runner script runs with (default: the engine's own Node when it
   * supports `--disable-sigusr1`, else `node` on an absolute `PATH` entry outside the repository
   * and the checkout, `resolveNodeExecutable`).
   */
  readonly node?: string;
}

/** Visible text of a gate that did not run for want of a sandbox (D-al). */
export const NO_SANDBOX_REFUSAL = `not run: ${GATE_SANDBOX.noSandboxReason} (macOS sandbox-exec or Linux bwrap); vtc doctor says why. To run gates unconfined anyway, set gates.allow_unsandboxed: true in ~/.vtc/config.yaml (an incident is recorded for every such gate run)`;

/** The order layers run in; L5 (engine code) runs last. */
const LAYER_ORDER: readonly GateLayer[] = ["L0", "L1", "L2", "L3", "L4", "L6", "L5"];
const WRITE_SCOPE_GATE = "write-scope";
const MAX_FINDINGS = 200;
const MAX_EVIDENCE = 20;

/** Reasons whose failures are compared with the base commit (only new problems block, §7.1). */
const BASELINE_REASONS: ReadonlySet<string> = new Set(["round", "merge_queue", "final_review"]);

const ownerOf = (request: Pick<GateRunRequest, "task" | "feature">): string | undefined =>
  request.task ?? request.feature;

const extFor = (format: string): string =>
  format === "junit" ? "xml" : format === "sarif" ? "sarif" : format === "json" ? "json" : "txt";

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
};

/** True when `path` exists and, symlinks resolved, stays inside `root` (also resolved). */
const resolvesInside = (root: string, path: string): boolean => {
  try {
    return isInside(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
};

interface Prepared {
  readonly argv: string[];
  readonly env: Record<string, string>;
  /** Set for a pinned scanner: it runs with the base version of changed scanner configs. */
  readonly scanner: boolean;
  /** Checkout-relative paths the command writes besides its report (pinned scanners). */
  readonly outputs: readonly string[];
  /** Checkout-relative rule files a pinned scanner reads. */
  readonly configs: readonly string[];
}

interface Execution {
  readonly refused?: string;
  readonly skipped?: string;
  readonly exec?: ExecResult;
  readonly reportText?: string;
  readonly reportProblem?: string;
}

interface BaselineFacts {
  readonly failingTests: ReadonlySet<string>;
  /** How often each finding key occurs on the base: a second identical finding is new. */
  readonly findingKeys: ReadonlyMap<string, number>;
  /** Set when the base run could not be used: every problem then counts as new. */
  readonly unusable?: string;
}

const findingKey = (f: Pick<ParsedFinding, "tool" | "rule_id" | "location" | "snippet">): string =>
  `${f.tool}\u0000${fingerprintFinding({
    rule_id: f.rule_id,
    path: f.location.path,
    symbol: f.location.symbol,
    snippet: f.snippet,
    line: f.location.line,
  })}`;

interface L2Outcome {
  readonly index: number;
  readonly cases: readonly JunitCase[];
  readonly reportRel: string;
}

/** A checkout-relative POSIX path for `abs`, or `null` when it is outside the checkout. */
const checkoutRel = (checkoutAbs: string, abs: string): string | null => {
  if (!isInside(checkoutAbs, abs)) return null;
  const rel = relative(checkoutAbs, abs).split(sep).join("/");
  return rel === "" ? null : rel;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What a walk of a checkout found: its directories and the guarded files in them. */
interface GuardedTree {
  /** Checkout-relative directories, `""` for the top. */
  readonly dirs: ReadonlySet<string>;
  /** Checkout-relative paths `guarded` matched (files, symlinks or anything else but a directory). */
  readonly files: readonly string[];
}

/**
 * Walks `root` without following a symlink and without entering a `.git`. With `within`, only
 * directories that were there before are entered: a directory a gate created (`node_modules`,
 * a build output) holds no file of the commit, and a config there governs only files that are
 * not the commit's either.
 */
const walkGuarded = (
  root: string,
  guarded: (path: string) => boolean,
  within?: ReadonlySet<string>,
): GuardedTree => {
  const dirs = new Set<string>([""]);
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (within !== undefined && !within.has(rel)) continue;
        dirs.add(rel);
        visit(rel);
      } else if (guarded(rel)) files.push(rel);
    }
  };
  visit("");
  return { dirs, files };
};

/** True when anything (a symlink included, not followed) is at `abs`. */
const present = (abs: string): boolean => {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
};

/** True when `abs` is a regular file (not followed through a symlink) holding exactly `bytes`. */
const holdsExactly = (abs: string, bytes: Uint8Array): boolean => {
  try {
    const stat = lstatSync(abs);
    if (!stat.isFile() || stat.size !== bytes.length) return false;
    return Buffer.from(bytes).equals(readFileSync(abs));
  } catch {
    return false;
  }
};

/** A redacted inventory, sorted and de-duplicated again by its redacted ids (TestInventorySchema). */
const redactedInventory = (tests: readonly TestRecord[], known: readonly string[]): TestInventory =>
  inventoryOf(redactJson(inventoryOf(tests).tests, known));

const renormalize = (redacted: unknown): unknown => inventoryOf((redacted as TestInventory).tests);

/** Failure classes a monotonic violation must not overwrite (§6.8: not the Engineer's fault). */
const KEPT_CLASSES: ReadonlySet<FailureClass> = new Set(["environment", "infra", "flaky"]);

class Run {
  private readonly writes: PendingWrite[] = [];
  private readonly secrets: string[] = [];
  private readonly results: GateResult[] = [];
  private readonly l2: L2Outcome[] = [];
  private readonly hiddenFiles: string[] = [];
  private diffCoverage: number | null = null;
  private config: GatesConfig | null = null;
  private visual: VisualSummary | null = null;
  /** §7.4 scope creep of this run's diff, when its L2 ran for a task or feature. */
  private scopeCreep: ScopeCreep | null = null;
  private changed: GitChangedFile[] = [];
  private baseCheckout: { rel: string; abs: string; installed: boolean } | null = null;
  /**
   * Clean checkouts the pinned scanners run in, by commit: no other gate ever runs there, so
   * nothing an install script, a build or a test wrote can reach a scanner (its configs, the
   * lockfiles, the sources or the checkout's `.git` link).
   */
  private readonly scannerCheckouts = new Map<string, Promise<{ rel: string; abs: string }>>();
  /** The run checkout's directories and L1-guarded files before any gate ran (L1 only). */
  private guardedAtStart: GuardedTree | null = null;
  /** Bytes of files at the head commit, read once per path. */
  private readonly headFiles = new Map<string, Promise<Uint8Array | undefined>>();
  private readonly baselines = new Map<string, Promise<BaselineFacts>>();
  private readonly attempt: string;
  private readonly evidenceRoot: string;
  private readonly stateRoot: string;
  private readonly checkoutAbs: string;
  private readonly started: Date;
  /** Runs every command in the gate sandbox; `null` when there is none (nothing runs). */
  private readonly jail: GateCommandJail | null;

  constructor(
    private readonly deps: GateRunnerDeps,
    private readonly scanners: ScannerStore,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly request: GateRunRequest,
    sandbox: GateSandbox | null,
    private readonly options: GateRunnerOptions = {},
    private readonly configOverride?: GatesConfig,
  ) {
    if (sandbox === null) this.jail = null;
    else {
      const policy = gateReadPolicy({ vtcHome: deps.vtcHome, env, repoRoot: deps.repoRoot });
      this.jail = new GateCommandJail(sandbox, policy.denyRead, policy);
    }
    this.started = this.now();
    const owner = ownerOf(request);
    const evidenceBase = owner === undefined ? null : `${EVIDENCE_DIR}/${owner}/gates`;
    const stateBase = `${GATES_STATE_DIR}/${request.run}`;
    this.attempt = attemptId(
      deps.repoRoot,
      evidenceBase === null ? [stateBase] : [stateBase, evidenceBase],
      request.reason,
      request.head,
      this.started,
    );
    this.stateRoot = `${stateBase}/${this.attempt}`;
    this.evidenceRoot =
      evidenceBase === null ? `${this.stateRoot}/evidence` : `${evidenceBase}/${this.attempt}`;
    this.checkoutAbs = join(deps.repoRoot, request.checkout);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The base commit's calibrated gates (§7.1); calibration alone reads the working tree. With
   * `gates_config_hash`, the base's bytes must be the `gates.yml` the run started with (spine §5
   * readings 20 and 46b): otherwise nothing runs.
   */
  private async loadConfig(): Promise<GatesConfig | null> {
    if (this.request.reason === "calibration") return loadGatesConfig(this.deps.repoRoot);
    const base = this.request.base.slice(0, 12);
    const bytes = await this.deps.git.readFileAtCommit(this.request.base, GATES_CONFIG_PATH);
    if (bytes === undefined) {
      throw new Error(
        `${GATES_CONFIG_PATH} is not committed at the base commit ${base}: run vtc calibrate and commit the file it writes`,
      );
    }
    const expected = this.request.gates_config_hash;
    if (expected !== undefined) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) {
        throw new Error(
          `${GATES_CONFIG_PATH} at the base commit ${base} (sha256 ${actual.slice(0, 12)}) does not match the gates.yml this run started with (sha256 ${expected.slice(0, 12)}): a run keeps its gates, so nothing ran`,
        );
      }
    }
    return parseGatesConfig(new TextDecoder().decode(bytes));
  }

  async execute(): Promise<GateReport> {
    let config: GatesConfig | null;
    try {
      config = this.configOverride ?? (await this.loadConfig());
      if (config === null) throw new Error(".vtc/gates.yml is missing: run vtc calibrate");
      if (!config.baseline.confirmed && this.request.reason !== "calibration") {
        throw new Error(".vtc/gates.yml is not confirmed: run vtc calibrate in a terminal");
      }
    } catch (error) {
      this.note(
        "config",
        `gates not run: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.results.push(
        this.infraResult("config", "L0", "verify", true, `${this.evidenceRoot}/config.log`),
      );
      return this.finish();
    }
    this.config = config;
    try {
      if (this.request.base !== this.request.head) {
        this.changed = [
          ...(await this.deps.git.changedFiles(this.request.base, this.request.head)),
        ];
      }
      await this.runGates(config);
      if (this.request.visual !== undefined) {
        // §7.3: hidden tests never reach evidence, and the app the visual step renders into
        // screenshots is project code: they leave the checkout first.
        this.removeHidden();
        await this.runVisual(config);
      }
    } catch (error) {
      // Never throw for a gate problem (GateRunner.run): an unexpected one is gate infrastructure.
      this.note(
        "gate-runner",
        `gate run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.results.push(
        this.infraResult(
          "gate-runner",
          "L0",
          "verify",
          true,
          `${this.evidenceRoot}/gate-runner.log`,
        ),
      );
    } finally {
      this.jail?.dispose();
      try {
        this.removeHidden();
        if (this.baseCheckout !== null) await this.deps.git.removeCheckout(this.baseCheckout.rel);
      } catch (error) {
        this.note("cleanup", `cleanup after the gates failed: ${errorText(error)}`);
      }
      for (const made of this.scannerCheckouts.values()) {
        try {
          const checkout = await made.catch(() => null);
          if (checkout !== null) await this.deps.git.removeCheckout(checkout.rel);
        } catch (error) {
          this.note("cleanup", `cleanup of a scanner checkout failed: ${errorText(error)}`);
        }
      }
    }
    if (this.jail?.ran === true && this.jail.kind === "none") {
      this.note(
        "sandbox",
        "gate commands ran without an OS sandbox: the user-level gates.allow_unsandboxed is set (D-al)",
      );
    }
    return this.finish();
  }

  // ------------------------------------------------------------------ gates

  private selectGates(config: GatesConfig): Gate[] {
    const r = this.request;
    const wanted = new Set<GateLayer>(
      r.reason === "base_fail_check" ? ["L2"] : (r.layers ?? LAYER_ORDER),
    );
    const verify = config.gates.filter((g) => g.phase === "verify" && wanted.has(g.layer));
    const install = config.gates.filter((g) => g.phase === "install");
    const order = (g: Gate): number => LAYER_ORDER.indexOf(g.layer);
    return [...install, ...[...verify].sort((a, b) => order(a) - order(b))];
  }

  /**
   * Install-phase gates run first, as one batch; the hidden acceptance tests are copied in only
   * after all of them, so no command with network access ever runs while they are in the
   * checkout (and the reaper has stopped whatever the install commands left).
   */
  private async runGates(config: GatesConfig): Promise<void> {
    let installFailed: string | null = null;
    let hiddenCopied = false;
    const gates = this.selectGates(config);
    if (gates.some((g) => g.phase === "verify" && g.layer === "L1")) {
      // Before any command ran: the checkout is still the clean head commit.
      this.guardedAtStart = walkGuarded(this.checkoutAbs, this.lintGuarded);
    }
    for (const gate of gates) {
      if (installFailed !== null) {
        this.results.push(this.skippedResult(gate, `install gate ${installFailed} did not pass`));
        continue;
      }
      if (gate.phase !== "install" && !hiddenCopied) {
        hiddenCopied = true;
        this.copyHidden();
      }
      const result = await this.runGate(gate, config);
      this.results.push(result);
      if (gate.phase === "install" && result.status !== "pass") installFailed = gate.id;
    }
    const guard =
      this.request.reason === "base_fail_check" || this.request.reason === "calibration";
    if (!guard && (this.request.layers ?? LAYER_ORDER).includes("L6")) {
      // §8.5: the Architect's AD Checks, compiled from the base commit's spine.
      const compiled = await compiledL6({
        git: this.deps.git,
        base: this.request.base,
        head: this.request.head,
        changed: this.changed,
        evidenceRoot: this.evidenceRoot,
      });
      this.results.push(...compiled.results);
      this.writes.push(...compiled.writes);
    }
    const wantsL5 =
      this.request.reason === "base_fail_check"
        ? false
        : (this.request.layers ?? LAYER_ORDER).includes("L5");
    if (
      wantsL5 &&
      this.request.task !== undefined &&
      (this.request.reason === "round" || this.request.reason === "merge_queue")
    ) {
      this.results.push(await this.writeScopeResult());
    }
    this.finishL2();
    await this.flagScopeCreep();
  }

  /**
   * §7.4: changed files no requirement covers. One info-level finding per path on the last L2
   * result (the run's combined L2 metrics), which keeps its status: scope creep never blocks.
   */
  private async flagScopeCreep(): Promise<void> {
    const r = this.request;
    const owner = ownerOf(r);
    const last = this.l2.at(-1);
    if (
      owner === undefined ||
      last === undefined ||
      r.reason === "base_fail_check" ||
      r.base === r.head
    ) {
      return;
    }
    const decoder = new TextDecoder();
    this.scopeCreep = await computeScopeCreep({
      changed: this.changed,
      cases: this.l2.flatMap((o) => o.cases),
      reqTags: r.req_tags,
      checkoutAbs: this.checkoutAbs,
      readHead: async (path) => {
        const bytes = await this.headFile(path);
        return bytes === undefined || bytes.length > 2 * 1024 * 1024
          ? undefined
          : decoder.decode(bytes);
      },
      exists: (path) => {
        const abs = join(this.checkoutAbs, path);
        return resolvesInside(this.checkoutAbs, abs) && existsSync(abs);
      },
    });
    const result = this.results[last.index];
    if (result === undefined || this.scopeCreep.paths.length === 0) return;
    const findings = scopeCreepFindings(this.scopeCreep.paths, traceabilityPath(owner));
    this.results[last.index] = {
      ...result,
      // info-level (`sarif_level: none`): listed, never counted as new violations (spine §5
      // reading 125); the status stays as the tests left it
      findings: [...result.findings, ...findings].slice(0, MAX_FINDINGS),
    };
  }

  private skippedResult(gate: Gate, reason: string): GateResult {
    return {
      gate_id: gate.id,
      layer: gate.layer,
      phase: gate.phase,
      status: "skipped",
      blocking: gate.blocking,
      new_violations: 0,
      baseline_violations: 0,
      monotonic: [],
      findings: [],
      evidence: [],
      duration_ms: 0,
      skipped_reason: reason.slice(0, 300),
    };
  }

  private infraResult(
    id: string,
    layer: GateLayer,
    phase: Gate["phase"],
    blocking: boolean,
    log: string,
    failureClass: FailureClass = "infra",
    durationMs = 0,
  ): GateResult {
    return {
      gate_id: id,
      layer,
      phase,
      status: "error",
      blocking,
      new_violations: 0,
      baseline_violations: 0,
      monotonic: [],
      findings: [],
      failure_class: failureClass,
      evidence: [{ type: "command_output", ref: log }],
      duration_ms: durationMs,
    };
  }

  /** A short explanation written to evidence (and nothing else) for a gate that did not run. */
  private note(gateId: string, text: string): void {
    this.writes.push({
      rel: `${this.evidenceRoot}/${gateId}.log`,
      redact: true,
      text: `${text}\n`,
    });
  }

  private changedExisting(): string[] {
    return this.changed.filter((f) => f.status !== "deleted").map((f) => f.path);
  }

  private async prepare(
    gate: Gate,
    checkoutAbs: string,
    cwd: string,
    changed: readonly string[],
  ): Promise<Prepared | { refused: string } | { skipped: string }> {
    const allowlist = readAllowlist(this.deps.vtcHome, this.deps.repoRoot);
    if (!gateCommandAllowed(gate.command, allowlist, this.scanners.names)) {
      return {
        refused: `not run: [${gate.command.join(" ")}] is not in this machine's gate allowlist; a human confirms it with vtc calibrate (§15)`,
      };
    }
    const [first, ...rest] = gate.command;
    let argv0 = first ?? "";
    const extraEnv: Record<string, string> = {};
    const scanner = this.scanners.names.includes(argv0);
    let outputs: readonly string[] = [];
    let configs: readonly string[] = [];
    let extraArgs: string[] = [];
    if (scanner) {
      // A pinned scanner passed the allowlist by name: its arguments are repo content.
      const check = checkScannerArgs(argv0, rest, { checkoutAbs, cwd });
      if (!check.ok) return { refused: `not run: ${check.problem}` };
      outputs = check.outputs;
      configs = check.configs;
      extraArgs = scannerExtraArgs(argv0, rest);
      if (argv0 === "osv-scanner") {
        // Offline with no database loads no advisories: never a silent pass (§6.8).
        if (!osvDatabaseReady(this.deps.vtcHome)) {
          return {
            refused:
              "not run: the osv-scanner offline vulnerability database is not on this machine; vtc calibrate downloads it when you confirm",
          };
        }
        extraEnv[OSV_DB_ENV] = osvDatabaseDir(this.deps.vtcHome);
      }
      try {
        const binary = await this.scanners.ensure(argv0);
        argv0 = binary;
      } catch (error) {
        if (!(error instanceof ScannerUnavailableError) || !USER_INSTALLED_SCANNERS.includes(argv0))
          return { refused: `not run: ${errorText(error)}` };
        // D-u (spine §5 reading 41): no native build here, so the user installs it themselves.
        const own = findUserInstalled(argv0, this.env.PATH, [this.deps.repoRoot, checkoutAbs]);
        if (own === null) {
          return {
            skipped: `${argv0} has no pinned build for ${error.platform} and is not installed on this machine, so this gate did not run; install ${argv0} yourself (vtc doctor warns about it) to enable it`,
          };
        }
        this.note(
          `${gate.id}-scanner`,
          `${argv0}: no pinned build for ${error.platform}; ran the user-installed ${own} (not SHA-verified by VTC)`,
        );
        argv0 = own;
      }
    }
    const needsRules = gate.command.some((t) => t.includes("{rules}"));
    const rules = needsRules ? ensureRules(this.deps.vtcHome) : "";
    const argv: string[] = [argv0];
    for (const token of rest) {
      if (token === "{changed}") {
        const files = changed.filter((p) => existsSync(join(checkoutAbs, p)));
        if (files.length === 0) return { skipped: "no changed files to check" };
        for (const p of files) argv.push(p.startsWith("-") ? `./${p}` : p);
        continue;
      }
      argv.push(
        token
          .replaceAll("{base}", this.request.base)
          .replaceAll("{head}", this.request.head)
          .replaceAll("{rules}", rules),
      );
    }
    argv.push(...extraArgs);
    return { argv, env: gateEnv(this.env, extraEnv), scanner, outputs, configs };
  }

  /**
   * Runs one command gate in a checkout; nothing here writes evidence except a note naming the
   * L1 configs an earlier gate had changed. `head`: the gate verifies the head commit (the run
   * checkout or a scanner checkout of the head), so the base's configs are pinned for it.
   */
  private async executeIn(
    gate: Gate,
    checkoutAbs: string,
    logPrefix: string,
    changed: readonly string[],
    head: boolean,
  ): Promise<Execution> {
    const cwd = join(checkoutAbs, gate.cwd ?? "");
    if (!existsSync(cwd) || !resolvesInside(checkoutAbs, cwd)) {
      return { refused: `not run: working directory ${gate.cwd ?? "."} is not in the checkout` };
    }
    const jail = this.jail;
    if (jail === null) return { refused: NO_SANDBOX_REFUSAL };
    const prepared = await this.prepare(gate, checkoutAbs, cwd, changed);
    if ("refused" in prepared) return { refused: prepared.refused };
    if ("skipped" in prepared) return { skipped: prepared.skipped };
    // A report path is relative to the gate's working directory, as the tool sees it.
    const reportAbs = gate.report === undefined ? null : join(cwd, gate.report.path);
    const reportRel = reportAbs === null ? null : checkoutRel(checkoutAbs, reportAbs);
    if (reportAbs !== null && reportRel === null) {
      return { refused: `not run: report ${gate.report?.path ?? ""} is not inside the checkout` };
    }
    try {
      // Nothing is removed or written through a symlink the diff planted (e.g. `.vtc/state`).
      for (const rel of [...(reportRel === null ? [] : [reportRel]), ...prepared.outputs]) {
        assertNoSymlinks(checkoutAbs, rel);
      }
      if (reportAbs !== null) rmSync(reportAbs, { force: true });
    } catch (error) {
      return { refused: `not run: ${errorText(error)}` };
    }
    if (head && gate.layer === "L1" && checkoutAbs === this.checkoutAbs) {
      // Install scripts and L0 builds ran role code in this checkout: L1 reads the commit's configs.
      try {
        const put = await this.restoreLintConfigs();
        if (put.length > 0) {
          this.note(
            `${gate.id}-configs`,
            `an earlier gate changed these lint configs in the checkout; ${gate.id} ran with the commit's version:\n${put.join("\n")}`,
          );
        }
      } catch (error) {
        return {
          refused: `not run: the lint configs an earlier gate changed could not be put back: ${errorText(error)}`,
        };
      }
    }
    const baseGlobs =
      gate.layer === "L1"
        ? (this.config?.tests.protected_configs ?? [])
        : prepared.scanner
          ? [...SCANNER_CONFIG_GLOBS, ...prepared.configs]
          : [];
    const restore =
      (baseGlobs.length > 0 || gate.layer === "L1") && head
        ? await this.useBaseConfigs(checkoutAbs, baseGlobs, gate.layer === "L1")
        : null;
    let exec: JailedResult;
    try {
      exec = await jail.run({
        phase: gate.phase,
        ...(this.config?.sandbox?.verify_loopback === true ? { loopback: true } : {}),
        checkout: checkoutAbs,
        argv: prepared.argv,
        cwd,
        env: prepared.env,
        timeoutMs: gate.timeout_s * 1000,
        stdoutPath: join(this.deps.repoRoot, `${logPrefix}.stdout.log`),
        stderrPath: join(this.deps.repoRoot, `${logPrefix}.stderr.log`),
      });
    } catch (error) {
      return { refused: `not run: the gate sandbox could not start it: ${errorText(error)}` };
    } finally {
      restore?.();
    }
    if (exec.leftover !== undefined) return { refused: `stopped: ${exec.leftover}` };
    if (reportAbs === null || exec.spawnError !== undefined || exec.timedOut) return { exec };
    if (!existsSync(reportAbs) || !resolvesInside(checkoutAbs, reportAbs)) {
      return { exec, reportProblem: `report ${gate.report?.path ?? ""} was not written` };
    }
    return { exec, reportText: readFileSync(reportAbs, "utf8") };
  }

  /** Files L1 reads with the commit's (or, where the diff changed them, the base's) version. */
  private readonly lintGuarded = (path: string): boolean =>
    matchesAnyCaseless(this.config?.tests.protected_configs ?? [], path) ||
    isGateCommandFile(path) ||
    isMixedConfig(path);

  private headFile(path: string): Promise<Uint8Array | undefined> {
    let read = this.headFiles.get(path);
    if (read === undefined) {
      read = this.deps.git.readFileAtCommit(this.request.head, path);
      this.headFiles.set(path, read);
    }
    return read;
  }

  /**
   * Puts every L1-guarded file of the run checkout back to the head commit, whether or not the
   * diff touched it: an install script, an L0 build or anything else an earlier gate ran may have
   * edited, added, deleted or replaced one, and L5 sees only the diff. Files the head does not
   * have are removed; the hidden tests stay. Returns the paths it changed, sorted.
   */
  private async restoreLintConfigs(): Promise<string[]> {
    const start = this.guardedAtStart;
    if (start === null) return [];
    const now = walkGuarded(this.checkoutAbs, this.lintGuarded, start.dirs);
    const hidden = new Set(this.hiddenFiles);
    const paths = [...new Set([...start.files, ...now.files])].filter((p) => !hidden.has(p)).sort();
    const rel = relative(this.deps.repoRoot, this.checkoutAbs).split(sep).join("/");
    const wanted = new Map<string, Uint8Array | undefined>();
    for (const path of paths) wanted.set(path, await this.headFile(path));
    const put: string[] = [];
    const clear = (path: string): void => {
      const abs = join(this.checkoutAbs, path);
      if (path.includes("/"))
        assertNoSymlinks(this.checkoutAbs, path.slice(0, path.lastIndexOf("/")));
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        return;
      }
      if (stat.isDirectory()) rmSync(abs, { recursive: true, force: true });
      else removeRepoFile(this.deps.repoRoot, `${rel}/${path}`);
    };
    // Removals first: on a case-insensitive file system a stray `.ESLintrc.json` is the same
    // entry as the `.eslintrc.json` restored after it.
    for (const [path, bytes] of wanted) {
      if (bytes !== undefined) continue;
      if (present(join(this.checkoutAbs, path))) {
        clear(path);
        put.push(path);
      }
    }
    for (const [path, bytes] of wanted) {
      if (bytes === undefined || holdsExactly(join(this.checkoutAbs, path), bytes)) continue;
      clear(path);
      writeRepoFile(this.deps.repoRoot, `${rel}/${path}`, bytes);
      put.push(path);
    }
    return [...new Set(put)].sort();
  }

  /** Whether a gate runs a pinned scanner (it then runs in a scanner checkout). */
  private isPinnedScanner(gate: Gate): boolean {
    return this.scanners.names.includes(gate.command[0] ?? "");
  }

  /** The absolute path of the clean scanner checkout of `commit`, made on first use. */
  private async scannerCheckout(commit: string): Promise<string> {
    let made = this.scannerCheckouts.get(commit);
    if (made === undefined) {
      made = this.deps.git
        .createCleanCheckout(commit)
        .then((rel) => ({ rel, abs: join(this.deps.repoRoot, rel) }));
      this.scannerCheckouts.set(commit, made);
    }
    return (await made).abs;
  }

  /**
   * L1 lints with the base commit's config (§7.2), and the scanners scan with the base commit's
   * scanner configs: config files the diff changed are put back to their base version for the
   * gate and restored afterwards, so a diff cannot silence the gates that verify it. With
   * `toolSections` (L1), task-runner files and package-manager configs are always put back, and
   * a changed `pyproject.toml`, `package.json` or `pnpm-workspace.yaml` keeps the head version
   * except for its tool sections or settings, which come from the base (`mixed-configs.ts`).
   */
  private async useBaseConfigs(
    checkoutAbs: string,
    globs: readonly string[],
    toolSections: boolean,
  ): Promise<(() => void) | null> {
    const whole = (path: string): boolean =>
      matchesAnyCaseless(globs, path) || (toolSections && isGateCommandFile(path));
    const pinned = (path: string): boolean => whole(path) || (toolSections && isMixedConfig(path));
    const touched = this.changed.filter(
      (f) => pinned(f.path) || (f.oldPath !== undefined && pinned(f.oldPath)),
    );
    if (touched.length === 0 || this.request.base === this.request.head) return null;
    const rel = relative(this.deps.repoRoot, checkoutAbs).split(sep).join("/");
    const saved: { path: string; head: Uint8Array | undefined }[] = [];
    const decoder = new TextDecoder();
    for (const file of touched) {
      for (const path of file.oldPath === undefined ? [file.path] : [file.path, file.oldPath]) {
        const head = await this.deps.git.readFileAtCommit(this.request.head, path);
        let base = await this.deps.git.readFileAtCommit(this.request.base, path);
        if (!whole(path)) {
          if (!isMixedConfig(path)) continue;
          const headText = head === undefined ? undefined : decoder.decode(head);
          const baseText = base === undefined ? undefined : decoder.decode(base);
          if (guardedSections(path, headText) === guardedSections(path, baseText)) continue;
          // A deleted file comes back whole; otherwise only its tool sections change.
          if (headText !== undefined) {
            base = new TextEncoder().encode(withBaseSections(path, headText, baseText));
          }
        }
        saved.push({ path, head });
        if (base === undefined) removeRepoFile(this.deps.repoRoot, `${rel}/${path}`);
        else writeRepoFile(this.deps.repoRoot, `${rel}/${path}`, base);
      }
    }
    if (saved.length === 0) return null;
    return () => {
      for (const { path, head } of saved) {
        if (head === undefined) removeRepoFile(this.deps.repoRoot, `${rel}/${path}`);
        else writeRepoFile(this.deps.repoRoot, `${rel}/${path}`, head);
      }
    };
  }

  private async runGate(gate: Gate, config: GatesConfig): Promise<GateResult> {
    if (
      gate.when_changed !== undefined &&
      !this.changed.some((f) => matchesAny(gate.when_changed ?? [], f.path))
    ) {
      return this.skippedResult(gate, "when_changed did not match the diff");
    }
    const started = Date.now();
    const logRel = `${this.evidenceRoot}/${gate.id}.log`;
    let checkoutAbs = this.checkoutAbs;
    if (this.isPinnedScanner(gate)) {
      try {
        checkoutAbs = await this.scannerCheckout(this.request.head);
      } catch (error) {
        this.note(
          gate.id,
          `not run: the clean checkout of the head commit for the scanner could not be made: ${errorText(error)}`,
        );
        return this.infraResult(gate.id, gate.layer, gate.phase, gate.blocking, logRel);
      }
    }
    const execution = await this.executeIn(
      gate,
      checkoutAbs,
      `${this.stateRoot}/${gate.id}`,
      this.changedExisting(),
      true,
    );
    if (execution.skipped !== undefined) return this.skippedResult(gate, execution.skipped);
    if (execution.refused !== undefined) {
      this.note(gate.id, execution.refused);
      return this.infraResult(gate.id, gate.layer, gate.phase, gate.blocking, logRel);
    }
    const exec = execution.exec;
    if (exec === undefined)
      return this.infraResult(gate.id, gate.layer, gate.phase, gate.blocking, logRel);
    const duration = Date.now() - started;
    const hiddenRun = gate.layer === "L2" && this.hiddenFiles.length > 0;
    const writeLog = (): Evidence => {
      if (hiddenRun)
        return { type: "command_output", ref: `${this.stateRoot}/${gate.id}.stdout.log` };
      this.writes.push({ rel: logRel, redact: true, text: exec.tail });
      return { type: "command_output", ref: logRel };
    };
    if (exec.spawnError !== undefined || exec.timedOut) {
      const reason = exec.timedOut
        ? `timed out after ${String(gate.timeout_s)} s`
        : `could not start ${gate.command[0] ?? ""}: ${exec.spawnError ?? ""}`;
      this.writes.push({
        rel: logRel,
        redact: true,
        text: `${reason}\n${hiddenRun ? "" : exec.tail}`,
      });
      return this.infraResult(
        gate.id,
        gate.layer,
        gate.phase,
        gate.blocking,
        logRel,
        classifyFailure({ spawnError: exec.spawnError, timedOut: exec.timedOut, log: "" }),
        duration,
      );
    }
    if (execution.reportProblem !== undefined) {
      this.writes.push({
        rel: logRel,
        redact: true,
        text: `${execution.reportProblem}\n${hiddenRun ? "" : exec.tail}`,
      });
      const cls = classifyFailure({
        timedOut: false,
        reportProblem: execution.reportProblem,
        log: exec.tail,
      });
      return this.infraResult(
        gate.id,
        gate.layer,
        gate.phase,
        gate.blocking,
        logRel,
        cls,
        duration,
      );
    }
    const reportRel =
      gate.report === undefined
        ? undefined
        : `${this.evidenceRoot}/${gate.id}.${extFor(gate.report.format)}`;
    if (gate.report !== undefined && execution.reportText !== undefined) {
      this.writes.push({
        rel: `${this.stateRoot}/${gate.id}.report.${extFor(gate.report.format)}`,
        redact: false,
        text: execution.reportText,
      });
    }
    const common = {
      gate_id: gate.id,
      layer: gate.layer,
      phase: gate.phase,
      blocking: gate.blocking,
      duration_ms: duration,
      ...(gate.report === undefined || reportRel === undefined
        ? {}
        : { report: { format: gate.report.format, path: reportRel } }),
    };
    try {
      if (
        gate.report?.format === "junit" &&
        execution.reportText !== undefined &&
        reportRel !== undefined
      ) {
        return await this.junitResult(
          gate,
          config,
          common,
          execution.reportText,
          reportRel,
          exec,
          writeLog,
        );
      }
      if (
        (gate.report?.format === "sarif" || gate.report?.format === "json") &&
        execution.reportText !== undefined &&
        reportRel !== undefined
      ) {
        return await this.findingsResult(
          gate,
          checkoutAbs,
          common,
          execution.reportText,
          reportRel,
          exec,
          writeLog,
        );
      }
    } catch (error) {
      const problem = `report ${gate.report?.path ?? ""} could not be read: ${error instanceof Error ? error.message : String(error)}`;
      this.writes.push({
        rel: logRel,
        redact: true,
        text: `${problem}\n${hiddenRun ? "" : exec.tail}`,
      });
      return this.infraResult(
        gate.id,
        gate.layer,
        gate.phase,
        gate.blocking,
        logRel,
        "infra",
        duration,
      );
    }
    if (
      gate.report !== undefined &&
      reportRel !== undefined &&
      execution.reportText !== undefined
    ) {
      this.writes.push({ rel: reportRel, redact: true, text: execution.reportText });
    }
    if (exec.code === 0) {
      return {
        ...common,
        status: "pass",
        new_violations: 0,
        baseline_violations: 0,
        monotonic: [],
        findings: [],
        evidence: [],
      };
    }
    return this.failed(common, exec, writeLog, []);
  }

  private failed(
    common: Omit<
      GateResult,
      "status" | "new_violations" | "baseline_violations" | "monotonic" | "findings" | "evidence"
    >,
    exec: ExecResult,
    writeLog: () => Evidence,
    failingTests: readonly string[],
    flaky: readonly string[] = [],
  ): GateResult {
    const log = writeLog();
    const cls = classifyFailure({
      timedOut: false,
      log: exec.tail,
      failingTests,
      flakyTests: flaky,
    });
    const evidence: Evidence[] = [log];
    const line = environmentSignatureLine(exec.tail);
    if (cls === "environment" && line !== null && log.ref.startsWith(EVIDENCE_DIR)) {
      evidence.push({ type: "log_line", ref: `${log.ref}:${String(line)}` });
    }
    return {
      ...common,
      status: "fail",
      new_violations: Math.max(1, failingTests.length),
      baseline_violations: 0,
      monotonic: [],
      findings: [],
      failure_class: cls,
      evidence,
    };
  }

  // -------------------------------------------------------------- L2 tests

  private hiddenIds(cases: readonly JunitCase[]): Set<string> {
    const hidden = new Set<string>();
    if (this.hiddenFiles.length === 0) return hidden;
    for (const c of cases) {
      const file = c.file?.replace(/\\/g, "/").replace(/^\.\//, "");
      if (
        (file !== undefined &&
          this.hiddenFiles.some((h) => file === h || file.endsWith(`/${h}`))) ||
        this.hiddenFiles.some((h) => c.id.startsWith(`${h} `))
      ) {
        hidden.add(c.id);
      }
    }
    return hidden;
  }

  private async junitResult(
    gate: Gate,
    config: GatesConfig,
    common: Omit<
      GateResult,
      "status" | "new_violations" | "baseline_violations" | "monotonic" | "findings" | "evidence"
    >,
    text: string,
    reportRel: string,
    exec: ExecResult,
    writeLog: () => Evidence,
  ): Promise<GateResult> {
    const r = this.request;
    const all = parseJunit(text);
    const selectedIds = r.tests === undefined ? null : new Set(r.tests);
    const cases = selectedIds === null ? all : all.filter((c) => selectedIds.has(c.id));
    const hidden = this.hiddenIds(cases);
    this.writes.push({ rel: reportRel, redact: true, text: toJunitXml(gate.id, cases, hidden) });
    const failing = cases
      .filter((c) => c.status === "fail" || c.status === "error")
      .map((c) => c.id);
    const junitEvidence = (ids: readonly string[]): Evidence[] =>
      ids.slice(0, MAX_EVIDENCE).map((id) => ({ type: "junit", ref: `${reportRel}#${id}` }));
    const counts = countsOf(cases);
    const metrics = this.writeInventory(gate, cases);
    const base = {
      ...common,
      tests: { ...counts, ...metrics },
      monotonic: [] as MonotonicViolation[],
      findings: [] as ToolFinding[],
    };

    this.l2.push({ index: this.results.length, cases, reportRel });
    if (r.reason === "base_fail_check") {
      // Decided once over every L2 gate in finishBaseFail: QA's tests may span several gates.
      return { ...base, status: "pass", new_violations: 0, baseline_violations: 0, evidence: [] };
    }

    let newFailing = failing;
    let baselineCount = 0;
    if (failing.length > 0 && this.baselineApplies(gate)) {
      const facts = await this.baseline(gate);
      newFailing = failing.filter((id) => !facts.failingTests.has(id));
      baselineCount = failing.length - newFailing.length;
    }
    if (newFailing.length > 0) {
      // Calibration recorded flaky ids from redacted inventories: compare in the same space.
      const flakySet = new Set(config.baseline.flaky_tests);
      const known = this.knownValues();
      const flaky = newFailing.filter(
        (id) => flakySet.has(id) || flakySet.has(redactSecrets(id, known)),
      );
      const result = this.failed(
        base,
        exec,
        () => ({ type: "junit", ref: reportRel }),
        newFailing,
        flaky,
      );
      return {
        ...result,
        new_violations: newFailing.length,
        baseline_violations: baselineCount,
        evidence: [...junitEvidence(newFailing), ...(hidden.size > 0 ? [] : [writeLog()])],
      };
    }
    if (exec.code !== 0 && failing.length === 0) {
      // The runner failed without a failing test (a crashed suite, a threshold): unsure means product.
      return { ...this.failed(base, exec, writeLog, []), baseline_violations: baselineCount };
    }
    return {
      ...base,
      status: "pass",
      new_violations: 0,
      baseline_violations: baselineCount,
      evidence: [],
    };
  }

  private writeInventory(
    gate: Gate,
    cases: readonly JunitCase[],
  ): Pick<TestMetrics, "inventory" | "line_coverage_pct" | "diff_coverage_pct"> {
    const rel = `${this.evidenceRoot}/${gate.id}.inventory.json`;
    this.writes.push({ rel, redact: true, json: inventoryOf(cases), normalize: renormalize });
    return { inventory: rel, line_coverage_pct: null, diff_coverage_pct: null };
  }

  /** Values redacted by value from evidence: `.env` values and secret-scanner matches so far. */
  private knownValues(): string[] {
    return knownSecretValues([this.deps.repoRoot, this.checkoutAbs], this.secrets);
  }

  /**
   * The base-fail rule (§6.3 step 2, §7.3), decided once over every L2 gate: QA's named tests
   * must all fail on the base, wherever they ran. A named test no gate executed does not fail.
   */
  private finishBaseFail(): void {
    const named = this.request.tests ?? [];
    const failingAll = new Set(
      this.l2.flatMap((o) =>
        o.cases.filter((c) => c.status === "fail" || c.status === "error").map((c) => c.id),
      ),
    );
    const allFail = named.length > 0 && named.every((id) => failingAll.has(id));
    for (const outcome of this.l2) {
      const result = this.results[outcome.index];
      if (result === undefined) continue;
      const ids = new Set(outcome.cases.map((c) => c.id));
      const evidence = (list: readonly string[]): Evidence[] =>
        list
          .slice(0, MAX_EVIDENCE)
          .map((id) => ({ type: "junit", ref: `${outcome.reportRel}#${id}` }));
      const failingHere = named.filter((id) => ids.has(id) && failingAll.has(id));
      this.results[outcome.index] =
        allFail && failingHere.length > 0
          ? {
              ...result,
              status: "fail",
              new_violations: failingHere.length,
              failure_class: "product",
              evidence: evidence(failingHere),
            }
          : allFail
            ? result
            : {
                ...result,
                evidence: evidence(named.filter((id) => ids.has(id) && !failingAll.has(id))),
              };
    }
    const executed = new Set(this.l2.flatMap((o) => o.cases.map((c) => c.id)));
    const missing = named.filter((id) => !executed.has(id));
    if (missing.length > 0) {
      this.note("base-fail", `named tests no L2 gate executed: ${missing.join(", ")}`);
    }
  }

  /**
   * Monotonic metrics (§7.3) on the run's combined L2 inventory, carried by the last L2 result
   * (what engine core passes back as the next run's `compare_to`). The previous inventory is
   * evidence, so it was redacted: the comparison runs on redacted ids on both sides.
   */
  private finishL2(): void {
    if (this.request.reason === "base_fail_check") {
      this.finishBaseFail();
      return;
    }
    const last = this.l2.at(-1);
    if (last === undefined) return;
    const result = this.results[last.index];
    if (result?.tests === undefined) return;
    const combined = this.l2.flatMap((o) => o.cases);
    let tests: TestMetrics = { ...result.tests, diff_coverage_pct: this.diffCoverage };
    if (this.l2.length > 1) {
      const rel = `${this.evidenceRoot}/l2-combined.inventory.json`;
      this.writes.push({ rel, redact: true, json: inventoryOf(combined), normalize: renormalize });
      tests = { ...tests, ...countsOf(inventoryOf(combined).tests), inventory: rel };
    }
    let monotonic: MonotonicViolation[] = [];
    const previous = this.request.compare_to;
    if (previous !== undefined) {
      const known = this.knownValues();
      const before = this.readInventory(previous.inventory, known);
      if (before === null) {
        // §6.8: a comparison that cannot run never passes silently.
        this.note(
          "monotonic",
          `monotonic metrics not compared: the previous inventory ${previous.inventory} is missing or not a valid test inventory`,
        );
        this.results.push(
          this.infraResult("monotonic", "L2", "verify", true, `${this.evidenceRoot}/monotonic.log`),
        );
      } else {
        monotonic = monotonicViolations(
          {
            inventory: redactedInventory(combined, known),
            line_coverage_pct: tests.line_coverage_pct,
            diff_coverage_pct: tests.diff_coverage_pct,
          },
          {
            inventory: before,
            line_coverage_pct: previous.line_coverage_pct,
            diff_coverage_pct: previous.diff_coverage_pct,
          },
          this.request.tests === undefined
            ? null
            : new Set(this.request.tests.map((id) => redactSecrets(id, known))),
        );
      }
    }
    const keep =
      result.status === "fail" &&
      result.failure_class !== undefined &&
      KEPT_CLASSES.has(result.failure_class);
    const updated: GateResult =
      monotonic.length === 0
        ? { ...result, tests }
        : {
            ...result,
            tests,
            status: "fail",
            monotonic,
            new_violations: result.new_violations + monotonic.length,
            failure_class: keep ? (result.failure_class ?? "product") : "product",
            evidence: [...result.evidence, { type: "command_output", ref: tests.inventory }],
          };
    this.results[last.index] = updated;
  }

  /** A previous run's inventory (evidence, so redacted), redacted again with today's values. */
  private readInventory(rel: string, known: readonly string[]): TestInventory | null {
    const abs = join(this.deps.repoRoot, rel);
    if (!resolvesInside(this.deps.repoRoot, abs)) return null;
    try {
      const parsed = TestInventorySchema.safeParse(JSON.parse(readFileSync(abs, "utf8")));
      return parsed.success ? redactedInventory(parsed.data.tests, known) : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------- findings gates

  private async findingsResult(
    gate: Gate,
    checkoutAbs: string,
    common: Omit<
      GateResult,
      "status" | "new_violations" | "baseline_violations" | "monotonic" | "findings" | "evidence"
    >,
    text: string,
    reportRel: string,
    exec: ExecResult,
    writeLog: () => Evidence,
  ): Promise<GateResult> {
    const doc: unknown = JSON.parse(text);
    this.writes.push({ rel: reportRel, redact: true, json: doc });
    const coverage = diffCoveragePct(doc);
    if (coverage !== null) this.diffCoverage = coverage;
    const ctx = {
      checkoutAbs,
      defaultCategory: gate.layer === "L1" ? ("maintainability" as const) : ("security" as const),
      fallbackPath: reportRel,
    };
    const parsed = isSarif(doc) ? parseSarif(doc, ctx) : parseJsonFindings(doc, ctx);
    this.secrets.push(...parsed.secrets);
    let fresh = parsed.findings;
    if (fresh.length > 0 && this.baselineApplies(gate)) {
      const facts = await this.baseline(gate);
      const remaining = new Map(facts.findingKeys);
      fresh = fresh.filter((f) => {
        const key = findingKey(f);
        const left = remaining.get(key) ?? 0;
        if (left === 0) return true;
        remaining.set(key, left - 1);
        return false;
      });
    }
    const baselineCount = parsed.findings.length - fresh.length;
    const sarif = isSarif(doc);
    const findings: ToolFinding[] = fresh.slice(0, MAX_FINDINGS).map(({ index, ...f }) => ({
      ...f,
      evidence: sarif
        ? { type: "sarif", ref: `${reportRel}#${String(index)}` }
        : { type: "command_output", ref: reportRel },
    }));
    const blocks =
      gate.layer === "L4"
        ? fresh.some(
            (f) =>
              f.category === "secret" ||
              f.category === "supply_chain" ||
              isAtLeast(
                normalizeSeverity({
                  source: "tool",
                  // AD-8 rule 7: outside the security class the cap is medium (contracts 4.2.0).
                  category: f.category,
                  ...(f.score === undefined ? {} : { score: f.score }),
                  ...(f.label === undefined ? {} : { label: f.label }),
                  ...(f.sarif_level === undefined ? {} : { sarifLevel: f.sarif_level }),
                }),
                "high",
              ),
          )
        : fresh.length > 0;
    const base = {
      ...common,
      monotonic: [],
      findings,
      new_violations: fresh.length,
      baseline_violations: baselineCount,
    };
    if (blocks) {
      return {
        ...base,
        status: "fail",
        failure_class: "product",
        evidence: [{ type: sarif ? "sarif" : "command_output", ref: reportRel }],
      };
    }
    if (exec.code !== 0 && parsed.findings.length === 0 && coverage === null) {
      return { ...this.failed(common, exec, writeLog, []), findings: [], baseline_violations: 0 };
    }
    if (coverage !== null && exec.code !== 0) {
      // diff-cover's --fail-under decided: below the threshold (§7.2 L3).
      return {
        ...this.failed(common, exec, writeLog, []),
        evidence: [{ type: "command_output", ref: reportRel }],
        failure_class: "product",
      };
    }
    return { ...base, status: "pass", evidence: [] };
  }

  // ----------------------------------------------------------------- baseline

  private baselineApplies(gate: Gate): boolean {
    const r = this.request;
    return (
      BASELINE_REASONS.has(r.reason) &&
      r.base !== r.head &&
      // A range-scoped command ({base}/{head}, e.g. a secret scan of base..head) reports only new problems.
      !gate.command.some((t) => t.includes("{base}") || t.includes("{head}")) &&
      (gate.layer === "L1" || gate.layer === "L2" || gate.layer === "L4") &&
      gate.report !== undefined &&
      gate.report.format !== "text"
    );
  }

  /** The same gate on a clean checkout of the base (cached per base commit and command). */
  private baseline(gate: Gate): Promise<BaselineFacts> {
    const key = `${gate.id}\u0000${gate.command.join("\u0000")}`;
    let job = this.baselines.get(key);
    if (job === undefined) {
      job = this.computeBaseline(gate);
      this.baselines.set(key, job);
    }
    return job;
  }

  private async computeBaseline(gate: Gate): Promise<BaselineFacts> {
    const unusable = (why: string): BaselineFacts => ({
      failingTests: new Set(),
      findingKeys: new Map(),
      unusable: why,
    });
    try {
      // A pinned scanner scans a clean checkout of the base, as it scans one of the head.
      let checkout: { abs: string; installed: boolean };
      if (this.isPinnedScanner(gate)) {
        checkout = { abs: await this.scannerCheckout(this.request.base), installed: true };
      } else {
        if (this.baseCheckout === null) {
          const rel = await this.deps.git.createCleanCheckout(this.request.base);
          this.baseCheckout = { rel, abs: join(this.deps.repoRoot, rel), installed: false };
        }
        checkout = this.baseCheckout;
      }
      const config = this.config;
      if (!checkout.installed && config !== null) {
        for (const install of config.gates.filter((g) => g.phase === "install")) {
          const done = await this.executeIn(
            install,
            checkout.abs,
            `${this.stateRoot}/base/${install.id}`,
            [],
            false,
          );
          if (done.exec?.code !== 0)
            return unusable(`install gate ${install.id} failed on the base`);
        }
        checkout.installed = true;
      }
      const execution = await this.executeIn(
        gate,
        checkout.abs,
        `${this.stateRoot}/base/${gate.id}`,
        this.changedExisting(),
        false,
      );
      if (execution.reportText === undefined || gate.report === undefined)
        return unusable("no report on the base");
      if (gate.report.format === "junit") {
        const failing = parseJunit(execution.reportText).filter(
          (c) => c.status === "fail" || c.status === "error",
        );
        return { failingTests: new Set(failing.map((c) => c.id)), findingKeys: new Map() };
      }
      const doc: unknown = JSON.parse(execution.reportText);
      const ctx = {
        checkoutAbs: checkout.abs,
        defaultCategory: "security" as const,
        fallbackPath: gate.report.path,
      };
      const parsed = isSarif(doc) ? parseSarif(doc, ctx) : parseJsonFindings(doc, ctx);
      this.secrets.push(...parsed.secrets);
      const keys = new Map<string, number>();
      for (const f of parsed.findings) keys.set(findingKey(f), (keys.get(findingKey(f)) ?? 0) + 1);
      return { failingTests: new Set(), findingKeys: keys };
    } catch (error) {
      return unusable(error instanceof Error ? error.message : String(error));
    }
  }

  // ------------------------------------------------------------ hidden tests

  /**
   * Copies the hidden acceptance tests (§7.3) of the run's tasks into the checkout, regular files
   * only. A task run copies its own task's. A feature run (Final Review, §6.7a step 2) copies the
   * tasks `hidden_tasks` names (engine core passes the feature's tasks); with none named it copies
   * nothing and says so in evidence, and `finalReviewStepsCovered` then does not report step 2.
   */
  private copyHidden(): void {
    const r = this.request;
    if (!r.include_hidden) return;
    const tasks = [
      ...new Set([...(r.task === undefined ? [] : [r.task]), ...(r.hidden_tasks ?? [])]),
    ];
    if (tasks.length === 0) {
      this.note(
        "hidden-tests",
        "hidden acceptance tests were not copied: the request names no tasks (hidden_tasks), so this run is not a full acceptance run (§6.7a step 2)",
      );
      return;
    }
    const owners = new Map<string, string>();
    for (const task of tasks) this.copyHiddenOf(task, owners);
  }

  /**
   * Copies one task's hidden tests. `owners` maps each copied path to its task: two tasks' tests
   * at the same path would silently replace one another, so that is an error (the run reports
   * infra) rather than a smaller acceptance run.
   */
  private copyHiddenOf(task: string, owners: Map<string, string>): void {
    const dir = join(
      this.deps.vtcHome,
      HIDDEN_TESTS.homeDir,
      engineRepoKey(this.deps.repoRoot),
      task,
    );
    if (!existsSync(dir)) return;
    const walk = (abs: string, rel: string): void => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
        else if (entry.isFile()) {
          const owner = owners.get(childRel);
          if (owner !== undefined) {
            throw new Error(
              `hidden acceptance tests of ${owner} and ${task} both have ${childRel}; neither may replace the other, so the acceptance run did not start`,
            );
          }
          owners.set(childRel, task);
          // Never through a symlink the diff planted: hidden tests must not land outside the checkout.
          assertNoSymlinks(this.checkoutAbs, childRel);
          const parent = childRel.includes("/") ? childRel.slice(0, childRel.lastIndexOf("/")) : "";
          if (parent !== "") ensureRepoDir(this.checkoutAbs, parent);
          copyFileSync(join(abs, entry.name), join(this.checkoutAbs, childRel));
          this.hiddenFiles.push(childRel);
        }
      }
    };
    walk(dir, "");
  }

  private removeHidden(): void {
    for (const rel of this.hiddenFiles) rmSync(join(this.checkoutAbs, rel), { force: true });
  }

  // ---------------------------------------------------------------------- L5

  private async writeScopeResult(): Promise<GateResult> {
    const started = Date.now();
    const r = this.request;
    const scopeRequest: WriteScopeCheckRequest = {
      worktree: r.checkout,
      base: r.base,
      head: r.head,
      filesScope: r.files_scope,
      protected: r.protected,
    };
    const report = await checkWriteScope(this.deps.git, scopeRequest, [
      ...DEFAULT_PROTECTED_GLOBS,
      ...(this.config?.tests.protected_configs ?? []),
    ]);
    const findings: ToolFinding[] = report.violations.slice(0, MAX_FINDINGS).map((v) => ({
      tool: "vtc-write-scope",
      rule_id: v.kind,
      category: "test_integrity",
      title: `${v.kind.replaceAll("_", " ")}: ${v.path}`.slice(0, 200),
      location: { path: v.path },
      evidence: { type: "diff", ref: `${r.base}..${r.head}` },
      label: "high",
    }));
    return {
      gate_id: WRITE_SCOPE_GATE,
      layer: "L5",
      phase: "verify",
      status: report.ok ? "pass" : "fail",
      blocking: true,
      new_violations: report.violations.length,
      baseline_violations: 0,
      monotonic: [],
      findings,
      ...(report.ok ? {} : { failure_class: "product" as const }),
      evidence: report.ok ? [] : [{ type: "diff", ref: `${r.base}..${r.head}` }],
      duration_ms: Date.now() - started,
    };
  }

  // ------------------------------------------------------------------ visual

  /**
   * The deterministic visual step (AD-24) the request asked for, after the gates. It never
   * changes `verdict` (rule 5): its outcome is `GateReport.visual`, and anything unexpected in it
   * is that step's `error`, never a crashed run.
   */
  private async runVisual(config: GatesConfig): Promise<void> {
    const evidenceDir = `${this.evidenceRoot}/visual`;
    const r = this.request;
    try {
      const allowlist = readAllowlist(this.deps.vtcHome, this.deps.repoRoot);
      const step = await runVisualStep({
        request: r,
        repoRoot: this.deps.repoRoot,
        vtcHome: this.deps.vtcHome,
        checkoutAbs: this.checkoutAbs,
        git: this.deps.git,
        changed: this.changed,
        config,
        env: this.env,
        gateEnv: gateEnv(this.env),
        runner:
          this.options.visualRunner ??
          sandboxedVisualRunner(this.jail, {
            node:
              this.options.node ??
              resolveNodeExecutable(
                this.env.PATH,
                [this.deps.repoRoot, this.checkoutAbs],
                engineNodeExecutable(),
              ),
            noSandbox: NO_SANDBOX_REFUSAL,
          }),
        allowCommand: (argv) => gateCommandAllowed(argv, allowlist),
        evidenceDir,
        logPrefix: join(this.deps.repoRoot, this.stateRoot, "visual"),
        ...(this.options.visualToolchains === undefined
          ? {}
          : { toolchains: this.options.visualToolchains }),
        now: () => this.now(),
      });
      this.writes.push(...step.writes);
      this.visual = step.summary;
    } catch (error) {
      const reportPath = `${evidenceDir}/report.json`;
      const outcome = visualWithoutRenders({
        run: r.run,
        task: r.task,
        feature: r.feature,
        status: "error",
        reason: `the visual step failed: ${errorText(error)}`,
        browser: null,
        findings: [],
        reportPath,
        writtenAt: this.now().toISOString(),
      });
      this.writes.push({ rel: reportPath, redact: true, json: outcome.report });
      this.visual = outcome.summary;
    }
  }

  // -------------------------------------------------------------- finishing

  /**
   * The report. Never throws (GateRunner.run): if writing evidence or validating the report
   * fails, the result is a minimal `infra_error` report without evidence.
   */
  private finish(): GateReport {
    try {
      return this.buildReport();
    } catch (error) {
      try {
        writeRepoFile(
          this.deps.repoRoot,
          `${this.stateRoot}/gate-runner.log`,
          `report could not be written: ${errorText(error)}\n`,
        );
      } catch {
        // nothing more to do: the report below says what happened
      }
      const r = this.request;
      const results = [
        this.infraResult("gate-runner", "L0", "verify", true, `${this.stateRoot}/gate-runner.log`),
      ];
      return {
        run: r.run,
        ...(r.task === undefined ? {} : { task: r.task }),
        ...(r.feature === undefined ? {} : { feature: r.feature }),
        reason: r.reason,
        scope: r.scope,
        base: r.base,
        head: r.head,
        expect: r.expect,
        results,
        ...this.sandboxField(),
        verdict: gateReportVerdict(results),
        started_at: this.started.toISOString(),
        finished_at: this.now().toISOString(),
      };
    }
  }

  /** `GateReport.sandbox`: set when a command ran (D-al). */
  private sandboxField(): Pick<GateReport, "sandbox"> {
    return this.jail?.ran === true ? { sandbox: this.jail.kind } : {};
  }

  private buildReport(): GateReport {
    const r = this.request;
    const owner = ownerOf(r);
    let traceability: string | undefined;
    if (owner !== undefined && this.l2.length > 0 && r.reason !== "base_fail_check") {
      const tests = this.l2.flatMap((o) => {
        const hidden = this.hiddenIds(o.cases);
        return o.cases.map((c) => ({ id: c.id, status: c.status, hidden: hidden.has(c.id) }));
      });
      traceability = traceabilityPath(owner);
      this.writes.push({
        rel: traceability,
        redact: true,
        json: buildTraceability({
          run: r.run,
          task: r.task,
          feature: r.feature,
          reqTags: r.req_tags,
          tests,
          scopeCreep: this.scopeCreep?.paths ?? [],
          builtAt: this.now().toISOString(),
        }),
      });
      const unjudged = this.scopeCreep?.unjudged ?? [];
      this.note(
        "traceability",
        `scope_creep lists changed JS/TS/Python files that no test tagged with the run's requirements is in or reaches through imports (§7.4; no per-test coverage contexts are read). Not judged: ${unjudged.length === 0 ? "none" : `${unjudged.slice(0, 50).join(", ")}${unjudged.length > 50 ? ` and ${String(unjudged.length - 50)} more` : ""}`}`,
      );
    }
    const known = knownSecretValues([this.deps.repoRoot, this.checkoutAbs], this.secrets);
    flushWrites(this.deps.repoRoot, this.writes, known);
    const results = redactJson(this.results, known);
    return GateReportSchema.parse({
      run: r.run,
      ...(r.task === undefined ? {} : { task: r.task }),
      ...(r.feature === undefined ? {} : { feature: r.feature }),
      reason: r.reason,
      scope: r.scope,
      base: r.base,
      head: r.head,
      expect: r.expect,
      results,
      ...(traceability === undefined ? {} : { traceability }),
      ...this.sandboxField(),
      ...(this.visual === null ? {} : { visual: redactJson(this.visual, known) }),
      verdict: gateReportVerdict(results),
      started_at: this.started.toISOString(),
      finished_at: this.now().toISOString(),
    });
  }
}

/**
 * A request that does not satisfy {@link GateRunRequestSchema} runs nothing: the Gate Runner is
 * the trust boundary for test material, and a malformed id (`../T-1`) would otherwise be joined
 * into hidden-test and evidence paths. The report is `error` / `infra` with the reasons in a log
 * under `.vtc/state/gates/rejected/`, a path built from no request field. Never throws.
 */
const rejectedRequest = (
  deps: GateRunnerDeps,
  request: GateRunRequest,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): GateReport => {
  const now = (): Date => deps.now?.() ?? new Date();
  const started = now();
  const dir = `${GATES_STATE_DIR}/rejected`;
  const log = `${dir}/${attemptId(deps.repoRoot, [dir], "request", "rejected", started)}/gate-runner.log`;
  const reasons = issues.map((i) => `${i.path.map(String).join(".") || "request"}: ${i.message}`);
  try {
    writeRepoFile(
      deps.repoRoot,
      log,
      `request rejected, no gate ran:\n${reasons.map((r) => `  ${r}`).join("\n")}\n`,
    );
  } catch {
    // nothing more to do: the report below says what happened
  }
  const results: GateResult[] = [
    {
      gate_id: "gate-runner",
      layer: "L0",
      phase: "verify",
      status: "error",
      blocking: true,
      new_violations: 0,
      baseline_violations: 0,
      monotonic: [],
      findings: [],
      failure_class: "infra",
      evidence: [{ type: "command_output", ref: log }],
      duration_ms: 0,
    },
  ];
  const r = request as Partial<GateRunRequest>;
  return {
    run: r.run ?? "",
    ...(r.task === undefined ? {} : { task: r.task }),
    ...(r.feature === undefined ? {} : { feature: r.feature }),
    reason: r.reason ?? "round",
    scope: r.scope ?? "full",
    base: r.base ?? "",
    head: r.head ?? "",
    expect: r.expect ?? "pass",
    results,
    verdict: gateReportVerdict(results),
    started_at: started.toISOString(),
    finished_at: now().toISOString(),
  };
};

/** The checked request, or the report that rejects it. */
const checkRequest = (
  deps: GateRunnerDeps,
  request: GateRunRequest,
): { request: GateRunRequest } | { report: GateReport } => {
  const parsed = GateRunRequestSchema.safeParse(request);
  return parsed.success
    ? { request: parsed.data }
    : { report: rejectedRequest(deps, request, parsed.error.issues) };
};

/**
 * One run against an explicit config instead of `.vtc/gates.yml`: `vtc calibrate` runs the
 * proposed gates before anything is written (the allowlist still applies).
 */
export const runWithConfig = (
  deps: GateRunnerDeps,
  options: GateRunnerOptions,
  request: GateRunRequest,
  config: GatesConfig,
): Promise<GateReport> => {
  const checked = checkRequest(deps, request);
  if ("report" in checked) return Promise.resolve(checked.report);
  return new Run(
    deps,
    options.scanners ?? createScannerStore({ vtcHome: deps.vtcHome }),
    options.env ?? process.env,
    checked.request,
    resolveGateSandbox(deps, options.detectSandbox),
    options,
    config,
  ).execute();
};

/** The Gate Runner with explicit options (tests inject fake scanners). */
export const createGateRunnerWith = (
  deps: GateRunnerDeps,
  options: GateRunnerOptions = {},
): GateRunner => {
  const scanners = options.scanners ?? createScannerStore({ vtcHome: deps.vtcHome });
  const env = options.env ?? process.env;
  // Detected once, on the first run that needs it (a short probe process).
  let detected: { readonly sandbox: GateSandbox | null } | null = null;
  const detect = (): GateSandbox | null => {
    detected ??= {
      sandbox: (options.detectSandbox ?? (() => detectGateSandbox().sandbox))(),
    };
    return detected.sandbox;
  };
  return {
    run: (request) => {
      const checked = checkRequest(deps, request);
      if ("report" in checked) return Promise.resolve(checked.report);
      return new Run(
        deps,
        scanners,
        env,
        checked.request,
        resolveGateSandbox(deps, detect),
        options,
      ).execute();
    },
    checkWriteScope: async (request) => {
      // The project's protected configs as calibrated at the base commit, plus the defaults.
      let globs: readonly string[] = [];
      try {
        const bytes = await deps.git.readFileAtCommit(request.base, GATES_CONFIG_PATH);
        if (bytes !== undefined) {
          globs = parseGatesConfig(new TextDecoder().decode(bytes)).tests.protected_configs;
        }
      } catch {
        // an unreadable gates.yml: the defaults still apply
      }
      return checkWriteScope(deps.git, request, [...DEFAULT_PROTECTED_GLOBS, ...globs]);
    },
    ...noveltySeam(deps),
  };
};
