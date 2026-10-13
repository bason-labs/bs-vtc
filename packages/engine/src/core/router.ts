/**
 * Risk Router (§6.3 steps 6–7, §5.3, §7.6). Deterministic: which reviewers a task gets (depth
 * scales with risk, skipped on trivial diffs) and which §7.6 risk rules a diff fires. The flow
 * composer and the Flow Studio graph use the same reviewer list, so the graph always shows what
 * the engine dispatches (D7).
 */
import {
  type Discipline,
  type GitChangedFile,
  type RiskRuleReasonRule,
  type Task,
} from "@vtc/shared";
import { globMatch } from "./globs.js";

/** Planner risk tags and intake hints that attach Security verify (§5.2, §7.6 rule 2). */
export const SECURITY_TAGS = [
  "auth",
  "authn",
  "authz",
  "rbac",
  "crypto",
  "payments",
  "pii",
  "secrets",
  "security",
] as const;

/** Disciplines with screens Visual QA can judge (§7.5; native mobile is out of scope, §1.2). */
const VISUAL_DISCIPLINES: readonly Discipline[] = ["frontend"];

/** Visual QA runs three calls and votes 2-of-3 per criterion (AD-8 rule 2). */
export const VISUAL_QA_CALLS = 3;

export interface ReviewerSlot {
  /** Stable slug, also the workflow node id. */
  readonly id: string;
  readonly role: string;
  readonly mode?: string;
  readonly subject?: string;
  readonly label: string;
  /** The router rule that added it (shown in Flow Studio, §17). */
  readonly reason: string;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * Reviewers for one verification round (§6.3 step 7):
 * - Spec-Verifier, one call per AC the task covers (or per REQ when the spec lists no AC);
 * - QA judge on high-risk tasks;
 * - Security verify on high-risk tasks and on security-tagged tasks;
 * - Visual QA (three calls) on UI tasks of a run with UI.
 */
export const reviewersFor = (
  task: Pick<Task, "id" | "risk" | "risk_tags" | "discipline" | "covers">,
  run: { readonly has_ui: boolean; readonly risk_hints: readonly string[] },
  acceptanceCriteria: readonly string[],
): ReviewerSlot[] => {
  const slots: ReviewerSlot[] = [];
  const subjects = acceptanceCriteria.length > 0 ? acceptanceCriteria : task.covers;
  for (const subject of subjects) {
    slots.push({
      id: subjects.length === 1 ? "spec-verifier" : `spec-verifier-${slug(subject)}`,
      role: "spec_verifier",
      subject,
      label: `Spec-Verifier ${subject}`,
      reason: "one call per AC (§7.4)",
    });
  }
  if (task.risk === "high") {
    slots.push({
      id: "qa-judge",
      role: "qa",
      mode: "judge",
      subject: task.id,
      label: "QA judge",
      reason: "risk high (§6.3 step 7)",
    });
  }
  const tags = [...task.risk_tags];
  const security =
    task.risk === "high" || tags.some((t) => (SECURITY_TAGS as readonly string[]).includes(t));
  if (security) {
    slots.push({
      id: "security-verify",
      role: "security",
      mode: "verify",
      subject: task.id,
      label: "Security verify",
      reason: task.risk === "high" ? "risk high (§6.3 step 7)" : "security risk tag (§5.3)",
    });
  }
  if (run.has_ui && VISUAL_DISCIPLINES.includes(task.discipline)) {
    for (let call = 1; call <= VISUAL_QA_CALLS; call += 1) {
      slots.push({
        id: `visual-qa-${String(call)}`,
        role: "visual_qa",
        label: `Visual QA ${String(call)}/${String(VISUAL_QA_CALLS)}`,
        reason: "UI task: three calls, 2-of-3 vote (§7.5)",
      });
    }
  }
  return slots;
};

/** A diff that changes only documentation needs no AI reviewers (§6.3 step 7, §11). */
export const isTrivialDiff = (files: readonly GitChangedFile[]): boolean =>
  files.length > 0 &&
  files.every((f) => /\.(md|mdx|txt|rst)$/i.test(f.path) || f.path.startsWith("docs/"));

/** §7.6 rule 5: CI/CD, IaC, Docker, git hooks, host and VTC config, lint or test config. */
export const PROTECTED_CONFIG_GLOBS = [
  ".github/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  "**/Dockerfile",
  "**/docker-compose*.yml",
  "**/*.tf",
  ".githooks/**",
  ".husky/**",
  ".claude/**",
  ".mcp.json",
  ".codex/**",
  ".vtc/**",
  "**/.eslintrc*",
  "**/eslint.config.*",
  "**/.prettierrc*",
  "**/tsconfig*.json",
  "**/jest.config.*",
  "**/vitest.config.*",
  "**/playwright.config.*",
  "**/pytest.ini",
  "**/.golangci.yml",
] as const;

/** §7.6 rule 2 built-ins: auth, RBAC, crypto and payments code (project globs add to them). */
export const SENSITIVE_AREA_GLOBS = [
  "**/auth/**",
  "**/rbac/**",
  "**/crypto/**",
  "**/payments/**",
  "**/billing/**",
] as const;

/** §7.6 rule 3: database migrations. */
export const MIGRATION_GLOBS = ["**/migrations/**", "**/migrate/**", "**/*.sql"] as const;

export interface DiffRiskInput {
  readonly files: readonly GitChangedFile[];
  /** Added plus deleted lines. */
  readonly changedLines: number;
  /** Project `risk_rules` (§7.6 rule 2 globs, rule 7 thresholds). */
  readonly riskRules: {
    readonly paths: readonly string[];
    readonly max_diff_lines: number;
    readonly max_diff_files: number;
  };
  /** Dependencies the diff adds that are not on the allowlist (§7.6 rule 4). */
  readonly newDependencies: readonly string[];
}

export interface RiskHit {
  readonly rule: RiskRuleReasonRule;
  readonly detail: string;
  readonly paths: readonly string[];
}

/**
 * The §7.6 rules a verified diff fires, in rule order. Rules 1 (secrets) and 9 (open high
 * findings) come from findings, rule 8 from repeated write-scope violations; rule 6 (breaking
 * public API) needs the L6 fitness checks and is reported by the Gate Runner.
 */
export const diffRiskHits = (input: DiffRiskInput): RiskHit[] => {
  const hits: RiskHit[] = [];
  const paths = input.files.flatMap((f) =>
    f.oldPath === undefined ? [f.path] : [f.path, f.oldPath],
  );
  const matching = (globs: readonly string[]): string[] =>
    paths.filter((p) => globs.some((g) => globMatch(g, p)));
  const sensitive = matching([...SENSITIVE_AREA_GLOBS, ...input.riskRules.paths]);
  if (sensitive.length > 0) {
    hits.push({
      rule: "sensitive_area",
      detail: "changes auth, RBAC, crypto, payments or a configured risk path",
      paths: sensitive,
    });
  }
  const migrations = matching(MIGRATION_GLOBS);
  if (migrations.length > 0) {
    hits.push({
      rule: "db_migration",
      detail: "adds or changes a database migration",
      paths: migrations,
    });
  }
  if (input.newDependencies.length > 0) {
    hits.push({
      rule: "new_dependency",
      detail: `new dependencies not on the allowlist: ${input.newDependencies.join(", ")}`,
      paths: [],
    });
  }
  const protectedConfig = matching(PROTECTED_CONFIG_GLOBS);
  if (protectedConfig.length > 0) {
    hits.push({
      rule: "protected_config",
      detail: "edits CI/CD, IaC, Docker, hooks, host/VTC, lint or test config",
      paths: protectedConfig,
    });
  }
  if (
    input.changedLines > input.riskRules.max_diff_lines ||
    input.files.length > input.riskRules.max_diff_files
  ) {
    hits.push({
      rule: "large_diff",
      detail: `${String(input.changedLines)} lines in ${String(input.files.length)} files exceeds ${String(input.riskRules.max_diff_lines)} lines or ${String(input.riskRules.max_diff_files)} files`,
      paths: [],
    });
  }
  return hits;
};
