/**
 * The deterministic visual stack (AD-24; spec §7.5, §9.1; D-ay): token lint, the design
 * detector, the render matrix with axe, computed styles and the per-region pixel diff, the
 * browser pin, and the novelty check against the per-client design library.
 */
export { appLoopbackPort, visualAppOf, VisualAppSchema, type VisualApp } from "./app.js";
export {
  BROWSER_STORE_NODE_MODULES,
  checkProjectBrowser,
  checkStoreBrowser,
  chromiumOf,
  packageEntry,
  PROJECT_BROWSER_PINS_DIR,
  projectBrowsersPath,
  projectPinPath,
  projectToolchain,
  readBrowserPin,
  resolvePackageDir,
  sha256File,
  storeToolchain,
  verifyPinnedBrowser,
  type BrowserCheck,
  type VisualToolchain,
} from "./browser.js";
export {
  colorLiterals,
  deltaE,
  parseCssColor,
  toOklab,
  toOklch,
  type Oklab,
  type Rgba,
} from "./color.js";
export {
  detect,
  DETECTOR_RULES,
  DETECTOR_TOOL,
  detectorFindings,
  detectorRule,
  type DetectorFile,
  type DetectorHit,
  type DetectorRule,
} from "./detector/index.js";
export { addedLinesWithNumbers, type AddedLine } from "./diff-lines.js";
export {
  evaluateVisual,
  MAX_SUMMARY_FINDINGS,
  ranOnProjectToolchain,
  styleMismatch,
  VISUAL_NOTE_RULE,
  VISUAL_PROJECT_TOOLCHAIN_RULE,
  visualWithoutRenders,
  type BrowserIdentity,
  type EvaluateInput,
  type VisualNote,
  type VisualOutcome,
  type VisualSettings,
} from "./evaluate.js";
export {
  DEFAULT_STATE,
  expandMatrix,
  parseScreens,
  type RenderJob,
  type RenderMatrix,
} from "./matrix.js";
export {
  checkNovelty,
  designLibraryDir,
  dhash,
  hammingDistance,
  NOVELTY_THRESHOLDS,
  noveltySeam,
  readDesignLibrary,
  recordDesignChoice,
  TOKEN_VECTOR_LENGTH,
  tokenDistance,
  tokenVector,
  type NoveltyInput,
} from "./novelty.js";
export { decodePng, encodePng, type RgbaImage } from "./png.js";
export {
  RUNNER_INPUT_FILE,
  RUNNER_OUT_DIR,
  RUNNER_RESULT_FILE,
  RUNNER_SCRIPT_FILE,
  RunnerResultSchema,
  STYLE_PROPERTIES,
  type RunnerInput,
  type RunnerJob,
  type RunnerRender,
  type RunnerResult,
} from "./protocol.js";
export {
  DISABLE_SIGUSR1,
  LINUX_PTRACE_REFUSAL,
  NO_RUNNER_NODE,
  engineNodeExecutable,
  resolveNodeExecutable,
  sandboxedVisualRunner,
  type SandboxedVisualRunnerOptions,
  type VisualRunner,
  type VisualRunnerCall,
  type VisualRunnerOutcome,
} from "./runner.js";
export { VISUAL_RUNNER_SCRIPT } from "./runner-script.js";
export {
  DEFAULT_TOOLCHAINS,
  PROTOTYPE_DIR,
  prototypeHash,
  runVisualStep,
  VISUAL_FIXED_TIME,
  type VisualStepContext,
  type VisualStepResult,
  type VisualToolchains,
} from "./step.js";
export { isUiSource, TOKEN_LINT_TOOL, tokenLint, type TokenLintSettings } from "./token-lint.js";
export {
  DESIGN_TOKENS_PATH,
  EMPTY_TOKENS,
  lengthPx,
  nearestColor,
  onScale,
  parseDesignTokens,
  type DesignTokens,
} from "./tokens.js";
