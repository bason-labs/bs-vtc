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
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  engineRepoKey,
  fingerprintFinding,
  gateCommandAllowed,
  gateReportVerdict,
  GateReportSchema,
  HIDDEN_TESTS,
  isAtLeast,
  normalizeSeverity,
  redactJson,
  type Evidence,
  type FailureClass,
  type Gate,
  type GateLayer,
  type GateReport,
  type GateResult,
  type GateRunner,
  type GateRunnerDeps,
  type GateRunRequest,
  type GatesConfig,
  type GitChangedFile,
  type MonotonicViolation,
  type TestMetrics,
  type ToolFinding,
  type WriteScopeCheckRequest,
} from "@vtc/shared";
import { assertNoSymlinks, ensureRepoDir, removeRepoFile, writeRepoFile } from "../git/index.js";
import { classifyFailure, environmentSignatureLine } from "./classify.js";
import { loadGatesConfig, readAllowlist } from "./config.js";
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
import { gateEnv, runCommand, type ExecResult } from "./exec.js";
import { matchesAny } from "./globs.js";
import { countsOf, inventoryOf, monotonicViolations } from "./metrics.js";
import { diffCoveragePct, parseJsonFindings } from "./parsers/json-reports.js";
import { parseJunit, type JunitCase } from "./parsers/junit.js";
import { isSarif, parseSarif } from "./parsers/sarif.js";
import type { ParsedFinding } from "./parsers/types.js";
import { ensureRules } from "./rules.js";
import { createScannerStore, type ScannerStore } from "./scanners.js";
import { buildTraceability } from "./traceability.js";
import { checkWriteScope } from "./write-scope.js";

export interface GateRunnerOptions {
  /** The pinned scanner store; default: the embedded pins under `deps.vtcHome`. */
  readonly scanners?: ScannerStore;
  /** The engine's environment, scrubbed before any gate sees it (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The order layers run in; L5 (engine code) runs last. */
const LAYER_ORDER: readonly GateLayer[] = ["L0", "L1", "L2", "L3", "L4", "L6", "L5"];
const WRITE_SCOPE_GATE = "write-scope";
const MAX_FINDINGS = 200;
const MAX_EVIDENCE = 20;

/** Reasons whose failures are compared with the base commit (only new problems block, §7.1). */
const BASELINE_REASONS: ReadonlySet<string> = new Set(["round", "merge_queue", "final_review"]);

/** Arguments that would let repo content run code or fetch unpinned rules through a scanner. */
export const scannerArgsProblem = (scanner: string, args: readonly string[]): string | null => {
  if (scanner === "checkov" && args.some((a) => /^--external-checks-(dir|git)\b/.test(a))) {
    return "checkov external checks run repository code";
  }
  if (scanner === "opengrep") {
    for (const [i, a] of args.entries()) {
      const value = a.startsWith("--config=")
        ? a.slice(9)
        : a === "--config" || a === "-c"
          ? args[i + 1]
          : undefined;
      if (value !== undefined && /^(https?:|p\/|r\/|auto$)/.test(value)) {
        return "opengrep rules must come from a local path, never the network";
      }
    }
  }
  if (
    scanner === "osv-scanner" &&
    !args.some((a) => a === "--offline" || a.startsWith("--offline="))
  ) {
    return "osv-scanner runs only with --offline (§7.2)";
  }
  return null;
};

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
  readonly findingKeys: ReadonlySet<string>;
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
}

class Run {
  private readonly writes: PendingWrite[] = [];
  private readonly secrets: string[] = [];
  private readonly results: GateResult[] = [];
  private readonly l2: L2Outcome[] = [];
  private readonly hiddenFiles: string[] = [];
  private diffCoverage: number | null = null;
  private config: GatesConfig | null = null;
  private changed: GitChangedFile[] = [];
  private baseCheckout: { rel: string; abs: string; installed: boolean } | null = null;
  private readonly baselines = new Map<string, Promise<BaselineFacts>>();
  private readonly attempt: string;
  private readonly evidenceRoot: string;
  private readonly stateRoot: string;
  private readonly checkoutAbs: string;
  private readonly started: Date;

  constructor(
    private readonly deps: GateRunnerDeps,
    private readonly scanners: ScannerStore,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly request: GateRunRequest,
    private readonly configOverride?: GatesConfig,
  ) {
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

  async execute(): Promise<GateReport> {
    let config: GatesConfig | null;
    try {
      config = this.configOverride ?? loadGatesConfig(this.deps.repoRoot);
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
      this.copyHidden();
      await this.runGates(config);
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
      this.removeHidden();
      if (this.baseCheckout !== null) await this.deps.git.removeCheckout(this.baseCheckout.rel);
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

  private async runGates(config: GatesConfig): Promise<void> {
    let installFailed: string | null = null;
    for (const gate of this.selectGates(config)) {
      if (installFailed !== null) {
        this.results.push(this.skippedResult(gate, `install gate ${installFailed} did not pass`));
        continue;
      }
      const result = await this.runGate(gate, config);
      this.results.push(result);
      if (gate.phase === "install" && result.status !== "pass") installFailed = gate.id;
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
    if (this.scanners.names.includes(argv0)) {
      const problem = scannerArgsProblem(argv0, rest);
      if (problem !== null) return { refused: `not run: ${problem}` };
      try {
        const binary = await this.scanners.ensure(argv0);
        if (argv0 === "osv-scanner") {
          extraEnv.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY = join(this.deps.vtcHome, "osv-db");
        }
        argv0 = binary;
      } catch (error) {
        return { refused: `not run: ${error instanceof Error ? error.message : String(error)}` };
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
    return { argv, env: gateEnv(this.env, extraEnv) };
  }

  /** Runs one command gate in a checkout; nothing here writes evidence. */
  private async executeIn(
    gate: Gate,
    checkoutAbs: string,
    logPrefix: string,
    changed: readonly string[],
  ): Promise<Execution> {
    const prepared = await this.prepare(gate, checkoutAbs, changed);
    if ("refused" in prepared) return { refused: prepared.refused };
    if ("skipped" in prepared) return { skipped: prepared.skipped };
    const cwd = join(checkoutAbs, gate.cwd ?? "");
    if (!existsSync(cwd) || !resolvesInside(checkoutAbs, cwd)) {
      return { refused: `not run: working directory ${gate.cwd ?? "."} is not in the checkout` };
    }
    // A report path is relative to the gate's working directory, as the tool sees it.
    const reportAbs = gate.report === undefined ? null : join(cwd, gate.report.path);
    if (reportAbs !== null) rmSync(reportAbs, { force: true });
    const restore =
      gate.layer === "L1" && checkoutAbs === this.checkoutAbs
        ? await this.useBaseConfigs(checkoutAbs)
        : null;
    let exec: ExecResult;
    try {
      exec = await runCommand({
        argv: prepared.argv,
        cwd,
        env: prepared.env,
        timeoutMs: gate.timeout_s * 1000,
        stdoutPath: join(this.deps.repoRoot, `${logPrefix}.stdout.log`),
        stderrPath: join(this.deps.repoRoot, `${logPrefix}.stderr.log`),
      });
    } finally {
      restore?.();
    }
    if (reportAbs === null || exec.spawnError !== undefined || exec.timedOut) return { exec };
    if (!existsSync(reportAbs) || !resolvesInside(checkoutAbs, reportAbs)) {
      return { exec, reportProblem: `report ${gate.report?.path ?? ""} was not written` };
    }
    return { exec, reportText: readFileSync(reportAbs, "utf8") };
  }

  /**
   * L1 lints with the base commit's config (§7.2): protected configs the diff changed are put back
   * to their base version for the lint and restored afterwards.
   */
  private async useBaseConfigs(checkoutAbs: string): Promise<(() => void) | null> {
    const globs = this.config?.tests.protected_configs ?? [];
    const touched = this.changed.filter(
      (f) => matchesAny(globs, f.path) || (f.oldPath !== undefined && matchesAny(globs, f.oldPath)),
    );
    if (touched.length === 0 || this.request.base === this.request.head) return null;
    const rel = relative(this.deps.repoRoot, checkoutAbs).split(sep).join("/");
    const saved: { path: string; head: Uint8Array | undefined }[] = [];
    for (const file of touched) {
      for (const path of file.oldPath === undefined ? [file.path] : [file.path, file.oldPath]) {
        const head = await this.deps.git.readFileAtCommit(this.request.head, path);
        const base = await this.deps.git.readFileAtCommit(this.request.base, path);
        saved.push({ path, head });
        if (base === undefined) removeRepoFile(this.deps.repoRoot, `${rel}/${path}`);
        else writeRepoFile(this.deps.repoRoot, `${rel}/${path}`, base);
      }
    }
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
    const execution = await this.executeIn(
      gate,
      this.checkoutAbs,
      `${this.stateRoot}/${gate.id}`,
      this.changedExisting(),
    );
    const logRel = `${this.evidenceRoot}/${gate.id}.log`;
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

    if (r.reason === "base_fail_check") {
      this.l2.push({ index: this.results.length, cases });
      const named = r.tests ?? [];
      const allFail = named.length > 0 && named.every((id) => failing.includes(id));
      return allFail
        ? {
            ...base,
            status: "fail",
            new_violations: failing.length,
            baseline_violations: 0,
            failure_class: "product",
            evidence: junitEvidence(failing),
          }
        : {
            ...base,
            status: "pass",
            new_violations: 0,
            baseline_violations: 0,
            evidence: junitEvidence(named.filter((id) => !failing.includes(id))),
          };
    }

    this.l2.push({ index: this.results.length, cases });
    let newFailing = failing;
    let baselineCount = 0;
    if (failing.length > 0 && this.baselineApplies(gate)) {
      const facts = await this.baseline(gate);
      newFailing = failing.filter((id) => !facts.failingTests.has(id));
      baselineCount = failing.length - newFailing.length;
    }
    if (newFailing.length > 0) {
      const result = this.failed(
        base,
        exec,
        () => ({ type: "junit", ref: reportRel }),
        newFailing,
        config.baseline.flaky_tests,
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
    this.writes.push({ rel, redact: true, json: inventoryOf(cases) });
    return { inventory: rel, line_coverage_pct: null, diff_coverage_pct: null };
  }

  /**
   * Monotonic metrics (§7.3) on the run's combined L2 inventory, carried by the last L2 result
   * (what engine core passes back as the next run's `compare_to`).
   */
  private finishL2(): void {
    const last = this.l2.at(-1);
    if (last === undefined) return;
    const result = this.results[last.index];
    if (result?.tests === undefined) return;
    const combined = this.l2.flatMap((o) => o.cases);
    let tests: TestMetrics = { ...result.tests, diff_coverage_pct: this.diffCoverage };
    if (this.l2.length > 1) {
      const rel = `${this.evidenceRoot}/l2-combined.inventory.json`;
      this.writes.push({ rel, redact: true, json: inventoryOf(combined) });
      tests = { ...tests, ...countsOf(inventoryOf(combined).tests), inventory: rel };
    }
    let monotonic: MonotonicViolation[] = [];
    const previous = this.request.compare_to;
    if (previous !== undefined && this.request.reason !== "base_fail_check") {
      const before = this.readInventory(previous.inventory);
      if (before !== null) {
        monotonic = monotonicViolations(
          {
            inventory: inventoryOf(combined),
            line_coverage_pct: tests.line_coverage_pct,
            diff_coverage_pct: tests.diff_coverage_pct,
          },
          {
            inventory: before,
            line_coverage_pct: previous.line_coverage_pct,
            diff_coverage_pct: previous.diff_coverage_pct,
          },
          this.request.tests === undefined ? null : new Set(this.request.tests),
        );
      }
    }
    const updated: GateResult =
      monotonic.length === 0
        ? { ...result, tests }
        : {
            ...result,
            tests,
            status: "fail",
            monotonic,
            new_violations: result.new_violations + monotonic.length,
            failure_class: "product",
            evidence: [...result.evidence, { type: "command_output", ref: tests.inventory }],
          };
    this.results[last.index] = updated;
  }

  private readInventory(rel: string): ReturnType<typeof inventoryOf> | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.deps.repoRoot, rel), "utf8")) as {
        tests?: unknown;
      };
      const tests = Array.isArray(raw.tests)
        ? (raw.tests as ReturnType<typeof inventoryOf>["tests"])
        : [];
      return inventoryOf(tests);
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------- findings gates

  private async findingsResult(
    gate: Gate,
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
      checkoutAbs: this.checkoutAbs,
      defaultCategory: gate.layer === "L1" ? ("maintainability" as const) : ("security" as const),
      fallbackPath: reportRel,
    };
    const parsed = isSarif(doc) ? parseSarif(doc, ctx) : parseJsonFindings(doc, ctx);
    this.secrets.push(...parsed.secrets);
    let fresh = parsed.findings;
    if (fresh.length > 0 && this.baselineApplies(gate)) {
      const facts = await this.baseline(gate);
      fresh = fresh.filter((f) => !facts.findingKeys.has(findingKey(f)));
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
      findingKeys: new Set(),
      unusable: why,
    });
    try {
      if (this.baseCheckout === null) {
        const rel = await this.deps.git.createCleanCheckout(this.request.base);
        this.baseCheckout = { rel, abs: join(this.deps.repoRoot, rel), installed: false };
      }
      const checkout = this.baseCheckout;
      const config = this.config;
      if (!checkout.installed && config !== null) {
        for (const install of config.gates.filter((g) => g.phase === "install")) {
          const done = await this.executeIn(
            install,
            checkout.abs,
            `${this.stateRoot}/base/${install.id}`,
            [],
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
      );
      if (execution.reportText === undefined || gate.report === undefined)
        return unusable("no report on the base");
      if (gate.report.format === "junit") {
        const failing = parseJunit(execution.reportText).filter(
          (c) => c.status === "fail" || c.status === "error",
        );
        return { failingTests: new Set(failing.map((c) => c.id)), findingKeys: new Set() };
      }
      const doc: unknown = JSON.parse(execution.reportText);
      const ctx = {
        checkoutAbs: checkout.abs,
        defaultCategory: "security" as const,
        fallbackPath: gate.report.path,
      };
      const parsed = isSarif(doc) ? parseSarif(doc, ctx) : parseJsonFindings(doc, ctx);
      this.secrets.push(...parsed.secrets);
      return { failingTests: new Set(), findingKeys: new Set(parsed.findings.map(findingKey)) };
    } catch (error) {
      return unusable(error instanceof Error ? error.message : String(error));
    }
  }

  // ------------------------------------------------------------ hidden tests

  /** Copies the task's hidden acceptance tests into the checkout (§7.3), regular files only. */
  private copyHidden(): void {
    const r = this.request;
    if (!r.include_hidden || r.task === undefined) return;
    const dir = join(
      this.deps.vtcHome,
      HIDDEN_TESTS.homeDir,
      engineRepoKey(this.deps.repoRoot),
      r.task,
    );
    if (!existsSync(dir)) return;
    const walk = (abs: string, rel: string): void => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
        else if (entry.isFile()) {
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
    const report = await checkWriteScope(this.deps.git, scopeRequest);
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

  // -------------------------------------------------------------- finishing

  private finish(): GateReport {
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
          builtAt: this.now().toISOString(),
        }),
      });
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
      verdict: gateReportVerdict(results),
      started_at: this.started.toISOString(),
      finished_at: this.now().toISOString(),
    });
  }
}

/**
 * One run against an explicit config instead of `.vtc/gates.yml`: `vtc calibrate` runs the
 * proposed gates before anything is written (the allowlist still applies).
 */
export const runWithConfig = (
  deps: GateRunnerDeps,
  options: GateRunnerOptions,
  request: GateRunRequest,
  config: GatesConfig,
): Promise<GateReport> =>
  new Run(
    deps,
    options.scanners ?? createScannerStore({ vtcHome: deps.vtcHome }),
    options.env ?? process.env,
    request,
    config,
  ).execute();

/** The Gate Runner with explicit options (tests inject fake scanners). */
export const createGateRunnerWith = (
  deps: GateRunnerDeps,
  options: GateRunnerOptions = {},
): GateRunner => {
  const scanners = options.scanners ?? createScannerStore({ vtcHome: deps.vtcHome });
  const env = options.env ?? process.env;
  return {
    run: (request) => new Run(deps, scanners, env, request).execute(),
    checkWriteScope: (request) => checkWriteScope(deps.git, request),
  };
};
