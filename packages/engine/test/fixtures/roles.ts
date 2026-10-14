/**
 * Role contracts for engine tests (formerly the engine's built-ins). The engine itself loads
 * role contracts only from the compiled plugin assets (`ROLE_CONTRACTS_ASSET`, AD-14 rule 6);
 * tests inject these through `createRoleRegistry`, or bundle them as that asset.
 */
import {
  HOST_IDS,
  RoleContractSchema,
  type ModelTier,
  type RoleContract,
  type RoleContractInput,
} from "@vtc/shared";

const VERDICTS = ["pass", "fail", "unknown"] as const;

const both = (tier: ModelTier, effort: "low" | "medium" | "high" = "medium") =>
  Object.fromEntries(HOST_IDS.map((h) => [h, { tier, effort }])) as RoleContractInput["models"];

const role = (
  input: Omit<RoleContractInput, "version" | "budget"> & {
    readonly budget?: RoleContractInput["budget"];
  },
): RoleContract =>
  RoleContractSchema.parse({ version: "1.0.0", budget: { context_tokens: 60_000 }, ...input });

export const FIXTURE_ROLES: readonly RoleContract[] = [
  role({
    id: "repo_cartographer",
    kind: "core",
    mission: "Map an existing repository for the run.",
    inputs: ["request", "repo_map"],
    output: { artifacts: ["repo_map"], verdicts: [] },
    exits: ["done", "blocked"],
    success_criteria: [
      {
        id: "citations_resolve",
        description: "Every statement cites a file or file_line that exists.",
      },
    ],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "write_scoped", write_paths: [".vtc/research/repo-map/**"] },
    budget: { context_tokens: 80_000 },
  }),
  role({
    id: "research_analyst",
    kind: "core",
    mission: "Research a new idea or a large feature with cited sources.",
    inputs: ["request", "repo_map"],
    output: { artifacts: ["research_brief"], verdicts: [] },
    exits: ["done", "blocked"],
    success_criteria: [
      {
        id: "citations_resolve",
        description: "Every claim cites a url or fact row the engine fetched.",
      },
    ],
    reviewer: "engine",
    models: both("mid", "high"),
    tools: {
      profile: "write_scoped",
      write_paths: [".vtc/research/briefs/**"],
      engine_tools: ["research_fetch", "fact_lookup", "fact_propose"],
    },
    budget: { context_tokens: 80_000 },
  }),
  role({
    id: "ba",
    kind: "core",
    mission: "Write the spec with REQ-n requirements and acceptance criteria.",
    inputs: ["request", "research_brief", "repo_map"],
    output: { artifacts: ["spec"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict"],
    success_criteria: [
      {
        id: "spec_ids",
        description: "Every requirement has a unique REQ-n id and every criterion a REQ-n.AC-m id.",
      },
    ],
    reviewer: "spec_verifier",
    models: both("top", "high"),
    tools: { profile: "write_scoped", write_paths: [".vtc/spec/**"] },
  }),
  role({
    id: "architect",
    kind: "core",
    mission: "Propose the architecture spine for the approved spec.",
    inputs: ["spec", "research_brief", "facts", "repo_map", "threat_model"],
    output: { artifacts: ["architecture", "design_note", "adr"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict"],
    success_criteria: [
      { id: "req_mapping", description: "Every REQ-n maps to at least one component." },
      {
        id: "facts_verified",
        description:
          "Every version, license, support or price claim cites a fact row or is marked UNVERIFIED.",
      },
    ],
    reviewer: "engine",
    models: both("top", "high"),
    tools: {
      profile: "write_scoped",
      write_paths: [".vtc/architecture/**"],
      engine_tools: ["research_fetch", "fact_lookup", "fact_propose"],
    },
    budget: { context_tokens: 80_000 },
  }),
  role({
    id: "designer",
    kind: "core",
    mission: "Design flows, screens and tokens for the approved spec.",
    inputs: [
      "spec",
      "research_brief",
      "repo_map",
      "architecture",
      "design_md",
      "component_manifest",
      "novelty_report",
    ],
    output: {
      artifacts: [
        "design_flows",
        "screens",
        "design_tokens",
        "component_specs",
        "prototype",
        "design_direction",
      ],
      verdicts: [],
    },
    exits: ["done", "blocked", "spec_conflict"],
    success_criteria: [
      {
        id: "screen_coverage",
        description: "Every user-facing REQ-n maps to a screen, and every screen lists its states.",
      },
    ],
    reviewer: "visual_qa",
    models: both("mid", "high"),
    tools: { profile: "write_scoped", write_paths: [".vtc/design/**"] },
    budget: { context_tokens: 80_000 },
  }),
  role({
    id: "planner",
    kind: "core",
    mission: "Split the approved design into tasks with intent contracts.",
    inputs: ["spec", "architecture", "threat_model", "design_flows", "screens", "repo_map"],
    output: { artifacts: ["tasks"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict"],
    success_criteria: [
      { id: "req_coverage", description: "Every REQ-n and SEC-n is covered by at least one task." },
      { id: "dag_acyclic", description: "The after and consumes_contracts graph has no cycle." },
      {
        id: "disjoint_parallel_scopes",
        description: "Tasks that can run in parallel have disjoint files_scope.",
      },
      {
        id: "task_size_cap",
        description: "Every task is within the size cap and has an architecture triage.",
      },
    ],
    reviewer: "engine",
    models: both("mid", "high"),
    tools: { profile: "read_only" },
  }),
  role({
    id: "qa",
    kind: "core",
    mission: "Author acceptance tests, or judge test adequacy.",
    inputs: ["task", "spec", "repo_map_slice", "interface_contract"],
    output: { artifacts: [], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict"],
    success_criteria: [
      {
        id: "base_fail_check",
        description: "Author mode: every new visible acceptance test fails on the base commit.",
      },
      {
        id: "req_tags",
        description: "Author mode: every acceptance test name carries the REQ or AC id it proves.",
      },
    ],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "read_only" },
    budget: { context_tokens: 50_000 },
    modes: {
      author: {
        inputs: ["task", "spec", "repo_map_slice", "interface_contract", "design_md"],
        output: {
          artifacts: ["acceptance_test", "hidden_acceptance_test", "scenario_card"],
          verdicts: [],
        },
        exits: ["done", "blocked", "spec_conflict"],
        tools: { profile: "write_scoped", write_paths: [".vtc/state/hidden-staging/**"] },
      },
      judge: {
        inputs: ["task", "spec", "diff", "acceptance_test", "gate_report", "traceability_report"],
        output: { artifacts: [], verdicts: [...VERDICTS] },
        exits: ["done", "blocked"],
        tools: { profile: "read_only" },
      },
    },
  }),
  role({
    id: "engineer",
    kind: "core",
    mission: "Implement the task inside its files_scope until the acceptance tests pass.",
    inputs: [
      "task",
      "spec",
      "architecture",
      "repo_map_slice",
      "interface_contract",
      "acceptance_test",
      "findings",
    ],
    output: { artifacts: ["interface_contract"], verdicts: [] },
    exits: ["built", "spec_conflict", "blocked", "out_of_scope_fault"],
    success_criteria: [
      {
        id: "write_scope",
        description:
          "Every changed file is inside the task's files_scope; protected files are unchanged.",
      },
      {
        id: "gates_green",
        description: "Gates L0 to L5 pass on a clean verification checkout of the submitted head.",
      },
      {
        id: "acceptance_tests_pass",
        description: "The task's visible and hidden acceptance tests pass.",
      },
    ],
    reviewer: "qa",
    models: both("mid"),
    tools: { profile: "code_sandboxed" },
    budget: { context_tokens: 80_000 },
  }),
  role({
    id: "spec_verifier",
    kind: "core",
    mission: "Judge one acceptance criterion against the built code, with evidence.",
    inputs: ["acceptance_criterion", "traceability_report", "test_results", "diff", "spec"],
    output: { artifacts: [], verdicts: [...VERDICTS] },
    exits: ["done"],
    success_criteria: [
      {
        id: "claim_check",
        description: "Every cited test, report entry and code line resolves.",
      },
    ],
    reviewer: "engine",
    models: both("low"),
    tools: { profile: "read_only" },
    budget: { context_tokens: 16_000 },
  }),
  role({
    id: "security",
    kind: "core",
    mission: "Threat-model the design, or verify the built diff.",
    inputs: ["spec", "architecture"],
    output: { artifacts: [], verdicts: [] },
    exits: ["done", "blocked"],
    reviewer: "engine",
    models: both("mid", "high"),
    tools: { profile: "read_only" },
    modes: {
      design: {
        inputs: ["request", "spec", "architecture", "repo_map"],
        output: { artifacts: ["threat_model"], verdicts: [] },
        exits: ["done", "blocked", "spec_conflict"],
        tools: { profile: "write_scoped", write_paths: [".vtc/architecture/threat-model/**"] },
      },
      verify: {
        inputs: ["task", "diff", "threat_model", "gate_report", "repo_map_slice"],
        output: { artifacts: [], verdicts: [...VERDICTS] },
        exits: ["done", "blocked"],
        tools: { profile: "read_only" },
      },
    },
  }),
  role({
    id: "visual_qa",
    kind: "core",
    mission: "Judge the rendered UI against the design criteria V1–V8.",
    inputs: [
      "task",
      "screens",
      "design_tokens",
      "design_md",
      "screenshots",
      "visual_report",
      "diff",
    ],
    output: { artifacts: [], verdicts: [...VERDICTS, "unchecked"] },
    exits: ["done"],
    success_criteria: [
      {
        id: "claim_check",
        description: "Every verdict cites a screenshot or element that exists.",
      },
    ],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "read_only" },
    budget: { context_tokens: 40_000 },
  }),
];

/** Advisors (§5.4), dispatched only through `consult` (spine §5 readings 25 and 30). */
export const FIXTURE_ADVISORS: readonly RoleContract[] = [
  role({
    id: "advisor_client_liaison",
    kind: "advisor",
    mission: "Write a client-facing export of the run's status.",
    inputs: [
      "advisor_question",
      "request",
      "spec",
      "architecture",
      "design_md",
      "change_request",
      "run_status",
      "cost_history",
    ],
    output: { artifacts: ["client_export"], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "human",
    models: both("mid"),
    tools: { profile: "write_scoped", write_paths: [".vtc/exports/**"] },
  }),
  role({
    id: "advisor_estimator",
    kind: "advisor",
    mission: "Estimate the cost, rounds and time a request or plan will take.",
    inputs: [
      "advisor_question",
      "request",
      "spec",
      "architecture",
      "tasks",
      "cost_history",
      "attachments",
    ],
    output: { artifacts: [], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "human",
    models: both("mid", "high"),
    tools: { profile: "read_only" },
  }),
];

/** Every fixture contract: what a compiled `vtc/role-contracts.json` would carry. */
export const ALL_FIXTURE_ROLES: readonly RoleContract[] = [...FIXTURE_ROLES, ...FIXTURE_ADVISORS];

/** A Tier-2 lens reviewer (§5.3), as roles/lens_db/role.yaml declares it. */
export const FIXTURE_LENS_DB: RoleContract = role({
  id: "lens_db",
  kind: "lens",
  mission: "Review a task's diff that touches schema or migrations against the DB lens checklist.",
  inputs: ["task", "diff", "gate_report"],
  output: { artifacts: [], verdicts: [...VERDICTS] },
  exits: ["done"],
  reviewer: "engine",
  models: both("mid", "high"),
  tools: { profile: "read_only" },
  budget: { context_tokens: 30_000 },
});

/** The lookback role (§13; roles/lookback/role.yaml): proposals only, at RETRO. */
export const FIXTURE_LOOKBACK: RoleContract = role({
  id: "lookback",
  kind: "core",
  mission: "Propose at most three changes to one role's editable prompt section.",
  inputs: ["traces", "scorecard", "prompt_proposal", "replay_result"],
  output: { artifacts: ["prompt_proposal"], verdicts: [] },
  exits: ["done", "blocked"],
  reviewer: "engine",
  models: both("top"),
  tools: { profile: "write_scoped", write_paths: [".vtc/lookback/proposals/**"] },
});
