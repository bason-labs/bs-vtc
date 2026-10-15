/**
 * Shared primitive schemas: identifiers, paths, timestamps and small value objects
 * reused by every contract. Spec references are to
 * docs/superpowers/specs/2026-10-12-vtc-system-design.md.
 */
import { z } from "zod";

// ---------------------------------------------------------------- identifiers

/** Task id, e.g. `T-7` (§6.3). */
export const TaskIdSchema = z.string().regex(/^T-[1-9]\d*$/, "expected a task id like T-7");
export type TaskId = z.infer<typeof TaskIdSchema>;

/** Feature id, e.g. `F-2` (§6.7a). A feature groups the tasks that ship together. */
export const FeatureIdSchema = z.string().regex(/^F-[1-9]\d*$/, "expected a feature id like F-2");
export type FeatureId = z.infer<typeof FeatureIdSchema>;

/** Escalation id, e.g. `E-12` (§6.5). */
export const EscalationIdSchema = z
  .string()
  .regex(/^E-[1-9]\d*$/, "expected an escalation id like E-12");
export type EscalationId = z.infer<typeof EscalationIdSchema>;

/** Requirement id: functional `REQ-n` from the BA or security `SEC-n` from Security design mode (§5.2). */
export const RequirementIdSchema = z
  .string()
  .regex(/^(REQ|SEC)-[1-9]\d*$/, "expected a requirement id like REQ-3 or SEC-1");
export type RequirementId = z.infer<typeof RequirementIdSchema>;

/**
 * Acceptance criterion id: `<requirement>.AC-n`, e.g. `REQ-3.AC-2` (§5.2 BA Given/When/Then;
 * the Spec-Verifier runs one call per AC, §7.4).
 */
export const AcceptanceCriterionIdSchema = z
  .string()
  .regex(
    /^(REQ|SEC)-[1-9]\d*\.AC-[1-9]\d*$/,
    "expected an acceptance criterion id like REQ-3.AC-2",
  );
export type AcceptanceCriterionId = z.infer<typeof AcceptanceCriterionIdSchema>;

/** A requirement or one of its acceptance criteria (`REQ-3` or `REQ-3.AC-2`). */
export const RequirementRefSchema = z
  .string()
  .regex(
    /^(REQ|SEC)-[1-9]\d*(\.AC-[1-9]\d*)?$/,
    "expected a requirement or acceptance criterion id like REQ-3 or REQ-3.AC-2",
  );
export type RequirementRef = z.infer<typeof RequirementRefSchema>;

/**
 * Run id. Used as a directory name under `.vtc/runs/<run>/`, so it is restricted to a
 * path-safe charset and may not start with a dot.
 */
export const RunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "expected a path-safe run id");
export type RunId = z.infer<typeof RunIdSchema>;

/** Role id, e.g. `engineer`, `spec_verifier`, `lens_db`. Open set; see {@link CORE_ROLES}. */
export const RoleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,47}$/, "expected a lower-case role id like spec_verifier");
export type RoleId = z.infer<typeof RoleIdSchema>;

/** Tier-1 roles from §5.2. Specialists, lenses and advisors use other ids. */
export const CORE_ROLES = [
  "lead",
  "repo_cartographer",
  "research_analyst",
  "ba",
  "architect",
  "security",
  "designer",
  "planner",
  "engineer",
  "qa",
  "spec_verifier",
  "visual_qa",
  "lookback",
] as const satisfies readonly RoleId[];
export type CoreRole = (typeof CORE_ROLES)[number];

/** Supported hosts (§12). */
export const HostIdSchema = z.enum(["claude-code", "codex"]);
export type HostId = z.infer<typeof HostIdSchema>;
export const HOST_IDS = HostIdSchema.options;

/** Download targets of the single-file binary and of pinned scanners (§4.4). */
export const PlatformSchema = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
]);
export type Platform = z.infer<typeof PlatformSchema>;

/** Lower-case slug used for stack packs, artifact types, rule ids and similar open sets. */
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "expected a lower-case slug");
export type Slug = z.infer<typeof SlugSchema>;

/** Artifact type named by prompts and ports (principle 2: prompts name artifact types, never paths). */
export const ArtifactTypeSchema = SlugSchema;
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

// ------------------------------------------------------------- hashes, times

export const Sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "expected a lower-case hex SHA-256 digest");
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/**
 * Full git object id: 40 hex (SHA-1 repositories) or 64 hex (SHA-256 repositories).
 * Abbreviations are rejected: they can become ambiguous as a repository grows, and baselines and
 * merge records must stay resolvable forever.
 */
export const GitShaSchema = z
  .string()
  .regex(/^([a-f0-9]{40}|[a-f0-9]{64})$/, "expected a full 40- or 64-hex git object id");
export type GitSha = z.infer<typeof GitShaSchema>;

/** ISO-8601 timestamp with a `Z` or numeric offset. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

// --------------------------------------------------------------------- paths

const isSafeRelative = (value: string): boolean => {
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\0")) return false;
  return !value.split("/").some((segment) => segment === "..");
};

/** Repo-relative POSIX path. Absolute paths, backslashes and `..` segments are rejected. */
export const RelPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeRelative, "expected a repo-relative POSIX path without '..'");
export type RelPath = z.infer<typeof RelPathSchema>;

/** Repo-relative glob (same safety rules as {@link RelPathSchema}). */
export const GlobSchema = RelPathSchema;
export type Glob = z.infer<typeof GlobSchema>;

/**
 * A glob that grants writes (`files_scope`, a role's `write_paths`): a {@link GlobSchema} without
 * parentheses, commas, quotes, backticks, whitespace or control characters (spine §5 reading 63).
 * These globs are LLM-authored (Planner task drafts) and end up inside host permission rules such
 * as Claude's comma-separated `Edit(<glob>)` allow list, where those characters could close a rule
 * and open another. So write-scope globs have no `{a,b}` alternatives: list each alternative as
 * its own entry. A bad draft fails at validation, not at spawn.
 */
export const WriteScopeGlobSchema = GlobSchema.regex(
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  /^[^\s(),'"`\u0000-\u001f\u007f]+$/,
  "write-scope globs have no parentheses, commas, quotes, backticks, whitespace or control characters",
);
export type WriteScopeGlob = z.infer<typeof WriteScopeGlobSchema>;

// -------------------------------------------------------------- value objects

/** Normalised severity (§6.3 step 8: the engine normalises, reviewers do not). */
export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** Task risk (§16). Drives the round cap: low = 3, med = 4, high = 5 (§6.3 step 9). */
export const RiskSchema = z.enum(["low", "med", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

/**
 * Model tier (§5.2 footnote): maps per host, e.g. Claude top/mid/low = Opus/Sonnet/Haiku. Lives
 * here since 5.4.0 so the task contracts can name it (difficulty routing, H-9); `role-contract.ts`
 * re-exports it.
 */
export const ModelTierSchema = z.enum(["top", "mid", "low"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** Reasoning effort of a role run (§5.2); `role-contract.ts` re-exports it. */
export const EffortSchema = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof EffortSchema>;

/** Token counts by type (§11 measurement, §16 Event.tokens). */
export const TokenUsageSchema = z.strictObject({
  in: z.int().nonnegative(),
  out: z.int().nonnegative(),
  cache_r: z.int().nonnegative(),
  cache_w: z.int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** A host session that can be resumed (§16 Task.session_ref). */
export const SessionRefSchema = z.strictObject({
  host: HostIdSchema,
  id: z.string().min(1).max(256),
});
export type SessionRef = z.infer<typeof SessionRefSchema>;

/**
 * The 13 risk rules of §7.6, in spec order. Each one parks the task and blocks Level-3
 * auto-merge; escalations and workflow nodes name the rule that fired.
 */
export const RiskRuleIdSchema = z.enum([
  "committed_secret",
  "sensitive_area",
  "db_migration",
  "new_dependency",
  "protected_config",
  "breaking_api",
  "large_diff",
  "repeated_test_integrity",
  "open_high_finding",
  "stuck_or_cap",
  "unresolved_spec_conflict",
  "gate_infra_or_sandbox",
  "budget_exhausted",
]);
export type RiskRuleId = z.infer<typeof RiskRuleIdSchema>;

/**
 * Rules 1–9: a park or escalation for one of these uses reason `risk_rule` plus the rule id.
 * Rules 10–13 always use their dedicated reason instead (`cap`/`stuck`, `spec_conflict`/
 * `change_request`, `gate_infra`, `budget`), so every situation has exactly one encoding.
 * `riskRuleForPark` maps any park back to the rule that fired (§6.7 Level-3 checklist item 5).
 */
export const RISK_RULE_REASON_RULES = [
  "committed_secret",
  "sensitive_area",
  "db_migration",
  "new_dependency",
  "protected_config",
  "breaking_api",
  "large_diff",
  "repeated_test_integrity",
  "open_high_finding",
] as const satisfies readonly RiskRuleId[];
export const RiskRuleReasonRuleSchema = z.enum(RISK_RULE_REASON_RULES);
export type RiskRuleReasonRule = z.infer<typeof RiskRuleReasonRuleSchema>;

/**
 * The one evidence vocabulary (principle 3, §7.4). Findings, role claims, verdicts, questions and
 * escalations all cite {@link EvidenceSchema}; the engine resolves every `ref` before it accepts
 * a result and discards evidence that does not resolve (§6.3 step 8). `ref` formats:
 *
 * | type             | `ref`                                   | Resolves when                          |
 * | ---------------- | --------------------------------------- | -------------------------------------- |
 * | `file`           | repo-relative path                      | the file exists at the result's head   |
 * | `file_line`      | `path:line` or `path:line-end`          | the file has that line                 |
 * | `log_line`       | `path:line` of a log under `.vtc/`      | the log has that line                  |
 * | `junit`          | `report-path#test-id`                   | the report has that test case          |
 * | `sarif`          | `report-path#rule-id` or `#result-index` | the report has that result            |
 * | `command_output` | path of captured output under `.vtc/`   | the file exists                        |
 * | `screenshot`     | path of an image under `.vtc/`          | the file exists                        |
 * | `diff`           | `base..head` (full SHAs)                | both commits exist                     |
 * | `commit`         | full git SHA                            | the commit exists                      |
 * | `test`           | test id as it appears in JUnit output   | the test exists in the latest report   |
 * | `spec_ref`       | `REQ-n`, `SEC-n` or `REQ-n.AC-m`        | the id is in the frozen spec           |
 * | `fact`           | row id in `.vtc/research/facts.jsonl`   | the row exists (§8.2)                  |
 * | `url`            | https URL                               | listed in the research brief or facts  |
 */
export const EvidenceTypeSchema = z.enum([
  "file",
  "file_line",
  "log_line",
  "junit",
  "sarif",
  "command_output",
  "screenshot",
  "diff",
  "commit",
  "test",
  "spec_ref",
  "fact",
  "url",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

/** Evidence the engine can resolve (principle 3: every AI verdict cites checkable evidence). */
export const EvidenceSchema = z.strictObject({
  type: EvidenceTypeSchema,
  ref: z.string().min(1).max(2048),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Visual QA criterion id, `V1`–`V8` (§5.2, §7.5). */
export const VisualCriterionIdSchema = z
  .string()
  .regex(/^V[1-8]$/, "expected a Visual QA criterion id V1–V8");
export type VisualCriterionId = z.infer<typeof VisualCriterionIdSchema>;

/**
 * What one verdict is about (§7.4, §7.5): an acceptance criterion or requirement (Spec-Verifier,
 * one call per AC), a Visual QA criterion `V1`–`V8`, a task (QA judge, Security verify) or a
 * feature (Final Review).
 */
export const VerdictSubjectSchema = z
  .string()
  .regex(
    /^((REQ|SEC)-[1-9]\d*(\.AC-[1-9]\d*)?|V[1-8]|T-[1-9]\d*|F-[1-9]\d*)$/,
    "expected an AC/REQ id, a Visual QA criterion V1–V8, a task id or a feature id",
  );
export type VerdictSubject = z.infer<typeof VerdictSubjectSchema>;

/** A location in the repo (§16 Finding.location, extended with optional lines). */
export const LocationSchema = z
  .strictObject({
    path: RelPathSchema,
    symbol: z.string().min(1).max(512).optional(),
    line: z.int().positive().optional(),
    end_line: z.int().positive().optional(),
  })
  .refine(
    (loc) => loc.end_line === undefined || (loc.line !== undefined && loc.end_line >= loc.line),
    { message: "end_line requires line and must be >= line", path: ["end_line"] },
  );
export type Location = z.infer<typeof LocationSchema>;

/** Engineering discipline of a task (§5.2a). One per task. */
export const CORE_DISCIPLINES = [
  "frontend",
  "backend",
  "mobile",
  "data",
  "devops",
  "ai_llm",
] as const;
/** Domain packs that may also act as a task discipline (§5.2a, §16 `<domain-pack>`). */
export const DOMAIN_PACKS = [
  "desktop",
  "embedded_iot",
  "cms",
  "web3",
  "search_relevance",
  "realtime",
  "video",
  "game_dev",
  "cli_tooling",
  "wasm",
  "wechat_mini_program",
  "us_public_sector",
] as const;
export const DisciplineSchema = z.enum([...CORE_DISCIPLINES, ...DOMAIN_PACKS]);
export type Discipline = z.infer<typeof DisciplineSchema>;
