/**
 * Evidence capture for automatic PRs (AD-27 rule 6, D-ce): the `EvidenceRecorder` the cli injects
 * as `AutomationDeps.evidence`, its sandboxed Playwright script, and the gate-report page that
 * is the non-UI evidence.
 */
export {
  BEFORE_AFTER_FILE_LIMIT_REASON,
  BEFORE_AFTER_STATE_DIR,
  buildGatesOf,
  captureBeforeAfter,
  planBeforeAfter,
  type BeforeAfterContext,
} from "./before-after.js";
export { cleanReason, deniedPattern } from "./clean.js";
export {
  createEvidenceRecorder,
  EVIDENCE_NO_BROWSER,
  EVIDENCE_NO_SANDBOX,
  sandboxedEvidenceRunner,
  type EvidenceRecorderDeps,
  type EvidenceRecorderOptions,
  type EvidenceRunner,
  type EvidenceRunnerCall,
} from "./recorder.js";
export {
  GATE_REPORT_HTML,
  gateReportHtml,
  MAX_REPORT_FINDINGS,
  scrubLocalPaths,
} from "./report-html.js";
export {
  DENIED_TEXT_HIT,
  DENY_SUBSTRING_MIN,
  EVIDENCE_MASK_COLOR,
  EVIDENCE_PAINT_DEFAULTS,
  EVIDENCE_VIDEO_SIZE,
  EvidenceRunnerResultSchema,
  MAX_SCAN_CHARS,
  UI_VIEWPORT_HEIGHT,
  type EvidenceRunnerApp,
  type EvidenceRunnerInput,
  type EvidenceRunnerResult,
  type EvidenceRunnerShot,
} from "./protocol.js";
export { EVIDENCE_RUNNER_SCRIPT } from "./script.js";
export type { CaptureTarget, TargetCaptureResult } from "./target.js";
