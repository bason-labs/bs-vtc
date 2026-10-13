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

/** Git object id (SHA-1 or SHA-256 repositories; abbreviations of 7+ allowed). */
export const GitShaSchema = z.string().regex(/^[a-f0-9]{7,64}$/, "expected a git object id");
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

// -------------------------------------------------------------- value objects

/** Normalised severity (§6.3 step 8: the engine normalises, reviewers do not). */
export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** Task risk (§16). Drives the round cap: low = 3, med = 4, high = 5 (§6.3 step 9). */
export const RiskSchema = z.enum(["low", "med", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

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

/** Kinds of evidence a finding, claim or escalation may cite. */
export const EvidenceTypeSchema = z.enum([
  "file_line",
  "log_line",
  "junit",
  "sarif",
  "command_output",
  "screenshot",
  "diff",
  "commit",
  "spec_ref",
  "url",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

/** Evidence the engine can resolve (principle 3: every AI verdict cites checkable evidence). */
export const EvidenceSchema = z.strictObject({
  type: EvidenceTypeSchema,
  ref: z.string().min(1).max(2048),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

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
