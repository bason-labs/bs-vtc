/**
 * Layer L6 compiled from the Architect's AD Checks (§8.5, §7.2 L6): each `vtc-check` block of
 * the approved spine becomes one L6 gate result, blocking or warn as the Check says. Runs in
 * process on the changed files (no command, so no allowlist entry is needed); external fitness
 * tools (dependency-cruiser, import-linter, ArchUnit…) stay calibrated L6 gates in `gates.yml`.
 */
import type { GateResult, GitChangedFile, GitOps, ToolFinding } from "@vtc/shared";
import type { PendingWrite } from "../evidence.js";
import { ARCHITECTURE_SPINE_PATH, parseAdChecks, type AdCheck } from "./checks.js";
import { evaluateAdCheck, PatternTimeoutError, type ArchFile } from "./evaluate.js";

export {
  AdCheckSpecSchema,
  ARCHITECTURE_SPINE_PATH,
  parseAdChecks,
  type AdCheck,
  type AdCheckSpec,
  type InvalidAdCheck,
} from "./checks.js";
export {
  dependenciesOf,
  evaluateAdCheck,
  importsOf,
  violationsOf,
  type ArchFile,
  type ArchViolation,
} from "./evaluate.js";

export const ARCH_TOOL = "vtc-arch";
const MAX_FINDINGS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface CompiledL6Input {
  readonly git: Pick<GitOps, "readFileAtCommit">;
  readonly base: string;
  readonly head: string;
  readonly changed: readonly GitChangedFile[];
  /** Repo-relative directory for the logs of Checks that could not be compiled. */
  readonly evidenceRoot: string;
}

const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined || bytes.length > MAX_FILE_BYTES
    ? undefined
    : new TextDecoder().decode(bytes);

const findingOf = (
  check: AdCheck,
  v: { path: string; line: number; text: string; detail: string },
): ToolFinding => ({
  tool: ARCH_TOOL,
  rule_id: `${ARCH_TOOL}/${check.ad}`,
  category: "architecture",
  title: `${check.ad}${check.title === "" ? "" : ` ${check.title}`}: ${v.path} ${v.detail}`.slice(
    0,
    200,
  ),
  message: (
    check.spec.message ?? `breaks the Check of ${check.ad} in ${ARCHITECTURE_SPINE_PATH}`
  ).slice(0, 4000),
  location: { path: v.path, line: v.line },
  evidence: { type: "file_line", ref: `${v.path}:${String(v.line)}` },
  snippet: v.text.slice(0, 4000),
  sarif_level: check.spec.mode === "blocking" ? "error" : "warning",
});

/** The compiled L6 results of a run; none when the base has no spine or the spine no Checks. */
export const compiledL6 = async (
  input: CompiledL6Input,
): Promise<{ readonly results: GateResult[]; readonly writes: PendingWrite[] }> => {
  const spine = decode(await input.git.readFileAtCommit(input.base, ARCHITECTURE_SPINE_PATH));
  if (spine === undefined) return { results: [], writes: [] };
  const { checks, invalid } = parseAdChecks(spine);
  const results: GateResult[] = [];
  const writes: PendingWrite[] = [];
  const notRun = (id: string, text: string): void => {
    const log = `${input.evidenceRoot}/${id}.log`;
    writes.push({ rel: log, redact: true, text });
    results.push({
      gate_id: id,
      layer: "L6",
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
    });
  };
  for (const bad of invalid) {
    notRun(
      bad.id,
      `${bad.ad}: the vtc-check block at ${ARCHITECTURE_SPINE_PATH}:${String(bad.line)} cannot be compiled, so its Check did not run: ${bad.problem}\n`,
    );
  }
  if (checks.length === 0) return { results, writes };
  const files: ArchFile[] = [];
  if (input.base !== input.head) {
    for (const f of input.changed) {
      if (f.status === "deleted") continue;
      const head = decode(await input.git.readFileAtCommit(input.head, f.path));
      if (head === undefined) continue;
      const base = decode(await input.git.readFileAtCommit(input.base, f.oldPath ?? f.path));
      files.push({ path: f.path, head, base });
    }
  }
  for (const check of checks) {
    const started = Date.now();
    let evaluated;
    try {
      evaluated = evaluateAdCheck(check.spec, files);
    } catch (error) {
      if (!(error instanceof PatternTimeoutError)) throw error;
      notRun(check.id, `${check.ad}: ${error.message}\n`);
      continue;
    }
    const { fresh, baseline } = evaluated;
    const failed = fresh.length > 0;
    results.push({
      gate_id: check.id,
      layer: "L6",
      phase: "verify",
      status: failed ? "fail" : "pass",
      blocking: check.spec.mode === "blocking",
      new_violations: fresh.length,
      baseline_violations: baseline,
      monotonic: [],
      findings: fresh.slice(0, MAX_FINDINGS).map((v) => findingOf(check, v)),
      ...(failed ? { failure_class: "product" as const } : {}),
      evidence: failed
        ? [
            { type: "file_line", ref: `${ARCHITECTURE_SPINE_PATH}:${String(check.line)}` },
            ...fresh
              .slice(0, 19)
              .map((v) => ({ type: "file_line" as const, ref: `${v.path}:${String(v.line)}` })),
          ]
        : [],
      duration_ms: Date.now() - started,
    });
  }
  return { results, writes };
};
