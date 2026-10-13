/** Valid example documents for every contract. Tests mutate copies to build invalid cases. */
import type {
  ProjectConfigInput,
  GatesConfigInput,
  RoleContractInput,
  RoleResultInput,
  TaskInput,
  VtcEventInput,
} from "../src/index.js";

export const SHA = "a".repeat(64);
export const NOW = "2026-10-13T08:00:00.000Z";

export const validTask = (): TaskInput => ({
  id: "T-7",
  title: "Add password reset endpoint",
  feature: "F-1",
  covers: ["REQ-3", "SEC-1"],
  after: ["T-2"],
  files_scope: ["src/auth/reset/**", "test/auth/reset.test.ts"],
  discipline: "backend",
  stack_packs: ["node-nest", "postgres"],
  provides_contract: { kind: "openapi", path: "contracts/auth.yaml", frozen_sha256: SHA },
  consumes_contracts: [{ provider: "T-2", kind: "data_contract", path: "contracts/users.yaml" }],
  risk: "high",
  cap: 5,
  size: "M",
  arch_triage: "extends",
  budget_usd: 5,
  spent_usd: 1.25,
  status: "fixing",
  round: 2,
  baseline_revision: "0123abcd",
  worktree: "/tmp/wt/T-7",
  branch: "vtc/T-7",
  session_ref: { host: "claude-code", id: "sess-123" },
  deferred: [SHA],
});

export const validFeature = () => ({
  id: "F-1",
  title: "Password reset",
  status: "final_review",
  tasks: ["T-7", "T-8"],
  integration_branch: "vtc/F-1",
  round: 1,
  budget_usd: 20,
  final_review_budget_usd: 3,
  spent_usd: 4,
  pr: { url: "https://github.com/acme/app/pull/12", draft: true },
});

export const validFindingDraft = () => ({
  rule_id: "authz.missing-check",
  category: "security",
  title: "Reset token not bound to user",
  message: "The token lookup ignores the user id.",
  confidence: 0.8,
  location: { path: "src/auth/reset/service.ts", symbol: "resetPassword", line: 42 },
  evidence: { type: "file_line", ref: "src/auth/reset/service.ts:42" },
  req_ids: ["SEC-1"],
  snippet: "const t = await tokens.find(token)",
  claimed_severity: "critical",
});

export const validFinding = () => ({
  ...validFindingDraft(),
  fingerprint: SHA,
  source: "role",
  source_name: "security",
  severity: "high",
  route: "patch",
  task: "T-7",
  round_first_seen: 1,
  round_last_seen: 2,
  status: "open",
});

export const validEscalation = () => ({
  id: "E-4",
  run: "run-2026-10-13",
  task: "T-7",
  reason: "cap",
  question: "The reset flow failed 5 rounds on the same finding. How should we proceed?",
  options: [
    { id: "hint", label: "Give the Engineer a hint", effect: "hint" },
    { id: "budget", label: "Raise budget 1.5x", effect: "raise_budget", budget_factor: 1.5 },
    {
      id: "waive",
      label: "Accept with waiver",
      effect: "waive",
      waiver_expires_at: "2026-11-01T00:00:00Z",
    },
  ],
  recommended: "hint",
  evidence: [{ type: "file_line", ref: ".vtc/evidence/T-7/round-5.json" }],
  blocks: ["T-7", "T-9"],
  created_at: NOW,
});

export const validEvent = (): VtcEventInput => ({
  v: 1,
  seq: 1,
  ts: NOW,
  run: "run-2026-10-13",
  task: "T-7",
  type: "role.submitted",
  actor: "role",
  role: "engineer",
  data: { exit: "built" },
  prompt_sha: SHA,
  host: "codex",
  model: "gpt-5-codex",
  tokens: { in: 1000, out: 200, cache_r: 5000, cache_w: 0 },
  cost_usd: 0.12,
});

export const validRoleResult = (): RoleResultInput => ({
  role: "security",
  mode: "verify",
  task: "T-7",
  exit: "done",
  verdict: "fail",
  findings: [validFindingDraft() as never],
  artifacts: [{ type: "findings", path: ".vtc/evidence/T-7/security.json" }],
  claims: [{ type: "file", ref: "src/auth/reset/service.ts" }],
  summary: "One high-severity authz finding in the reset service.",
});

export const validRoleContract = (): RoleContractInput => ({
  id: "ba",
  version: "1.0.0",
  kind: "core",
  mission: "Turn the request into an EARS spec with acceptance criteria.",
  inputs: ["research_brief", "repo_map"],
  output: { artifacts: ["spec"], verdicts: [] },
  exits: ["done", "blocked", "unknown"],
  success_criteria: [{ id: "every-req-has-ac", description: "Every REQ has at least one AC." }],
  reviewer: "spec_verifier",
  models: {
    "claude-code": { tier: "top", effort: "high" },
    codex: { tier: "top", effort: "high", model: "gpt-5" },
  },
  tools: { profile: "write_scoped", write_paths: [".vtc/spec/**"] },
  budget: { context_tokens: 60000 },
  host_overrides: { codex: { prompt_append: "Return JSON only." } },
});

export const validGatesConfig = (): GatesConfigInput => ({
  version: 1,
  baseline: { revision: "0123abcd", calibrated_at: NOW, confirmed: true, flaky_tests: ["t1"] },
  sources: ["task_runner", "ci"],
  gates: [
    {
      id: "install",
      layer: "L0",
      command: ["pnpm", "install", "--frozen-lockfile"],
      phase: "install",
    },
    { id: "typecheck", layer: "L0", command: ["pnpm", "typecheck"] },
    {
      id: "tests",
      layer: "L2",
      command: ["pnpm", "test"],
      report: { format: "junit", path: "reports/junit.xml" },
    },
    { id: "checkov", layer: "L4", command: ["checkov", "-d", "."], when_changed: ["infra/**"] },
    { id: "deps", layer: "L6", command: ["depcruise", "src"], blocking: false },
  ],
  scanners: [{ name: "gitleaks", version: "8.30.0", sha256: SHA }],
});

export const validProjectConfig = (): ProjectConfigInput => ({ version: 1 });
