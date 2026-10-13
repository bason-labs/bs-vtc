/**
 * Gate Runner (AD-13; owner: gate-runner team, sub-project 2): calibration, baseline, layers
 * L0–L5, the L5 write-scope and test-integrity check, hidden tests, the pinned scanner store.
 * Implements `GateRunner` from @vtc/shared; the cli builds it with `createGateRunner` and injects
 * it into the daemon (AD-19). Exposes its public API from this file only and never imports
 * engine core, http or mcp. Git access goes only through the injected `GateRunnerDeps.git`
 * (`GitOps`, AD-13 rule 4): the gate-runner team writes no git code.
 */
import type { CreateGateRunner } from "@vtc/shared";
import { createGateRunnerWith } from "./runner.js";

export { parseXml, findAll, XmlError, type XmlElement } from "./parsers/xml.js";
export { parseJunit, junitTestId, type JunitCase } from "./parsers/junit.js";
export { parseSarif, isSarif } from "./parsers/sarif.js";
export {
  parseJsonFindings,
  detectJsonReport,
  diffCoveragePct,
  type JsonReportKind,
} from "./parsers/json-reports.js";
export type { ParsedFinding, ParsedFindings, ParseContext } from "./parsers/types.js";

/** The Gate Runner the cli injects into the daemon (AD-19). */
export const createGateRunner: CreateGateRunner = (deps) => createGateRunnerWith(deps);
export {
  checkWriteScope,
  addedLinesByFile,
  scanAddedLines,
  SKIP_PATTERNS,
  SUPPRESSION_PATTERNS,
  SNAPSHOT_GLOBS,
} from "./write-scope.js";
export { globMatch, globToRegExp, matchesAny } from "./globs.js";
export {
  inventoryOf,
  countsOf,
  monotonicViolations,
  type MetricsSnapshot,
  type TestCounts,
} from "./metrics.js";
export { buildTraceability, tagCovers, type TraceabilityInput } from "./traceability.js";
export { SCANNER_PINS, SCANNER_ASSETS, type ScannerAssets } from "./scanner-pins.js";
export {
  createScannerStore,
  currentPlatform,
  defaultDownload,
  defaultExtract,
  scannerUrl,
  ScannerError,
  SCANNERS_DIR,
  type Download,
  type Extract,
  type ScannerStore,
  type ScannerStoreOptions,
} from "./scanners.js";
export { ensureRules, PRODUCT_RULES, rulesHash } from "./rules.js";
export {
  addToAllowlist,
  allowlistPath,
  GATES_CONFIG_PATH,
  GatesConfigError,
  loadGatesConfig,
  parseGatesConfig,
  readAllowlist,
  stringifyGatesConfig,
} from "./config.js";
export { gateEnv, runCommand, PASSED_ENV, type ExecRequest, type ExecResult } from "./exec.js";
export { createGateRunnerWith, type GateRunnerOptions } from "./runner.js";
export {
  checkScannerArgs,
  scannerArgsProblem,
  scannerExtraArgs,
  SCANNER_SPECS,
  type ScannerArgsCheck,
  type ScannerArgsContext,
} from "./scanner-args.js";
export {
  downloadOsvDatabase,
  OSV_DB_DIR,
  OSV_DB_ENV,
  OSV_DB_STAMP,
  osvDatabaseDir,
  osvDatabaseReady,
  type OsvDownloadRequest,
} from "./osv-db.js";
export {
  DEFAULT_PROTECTED_GLOBS,
  LINT_TEST_CONFIG_GLOBS,
  SCANNER_CONFIG_GLOBS,
} from "./protected-globs.js";
export { guardedSections, isMixedConfig, withBaseSections } from "./mixed-configs.js";
export { classifyFailure, environmentSignatureLine, ENVIRONMENT_SIGNATURES } from "./classify.js";
export {
  attemptId,
  EVIDENCE_DIR,
  GATES_STATE_DIR,
  HIDDEN_DETAILS_WITHHELD,
  knownSecretValues,
  toJunitXml,
  traceabilityPath,
} from "./evidence.js";
export { finalReviewStepsCovered } from "./final-review.js";
export { runWithConfig } from "./runner.js";
export {
  allowlistPrefix,
  detectTestLayout,
  detectToolchain,
  listFiles,
  REPORT_DIR,
  slotOf,
  splitCommand,
  type Detection,
  type DetectOptions,
  type ProposedGate,
} from "./calibrate/detect.js";
export {
  calibrate,
  flakyBetween,
  type CalibrateDeps,
  type CalibrateOutcome,
} from "./calibrate/calibrate.js";
