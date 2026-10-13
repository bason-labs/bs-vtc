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

const VERDICTS = ["pass", "fail", "unknown", "unchecked"] as const;

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
    inputs: ["request"],
    output: { artifacts: ["repo_map"], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "engine",
    models: both("low"),
    tools: { profile: "write_scoped", write_paths: [".vtc/research/**"] },
  }),
  role({
    id: "research_analyst",
    kind: "core",
    mission: "Research a new idea or a large feature with cited sources.",
    inputs: ["request"],
    output: { artifacts: ["research_brief"], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "write_scoped", write_paths: [".vtc/research/**"] },
  }),
  role({
    id: "ba",
    kind: "core",
    mission: "Write the spec with REQ-n requirements and acceptance criteria.",
    inputs: ["request"],
    output: { artifacts: ["spec"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict", "unknown"],
    reviewer: "spec_verifier",
    models: both("top", "high"),
    tools: { profile: "write_scoped", write_paths: [".vtc/spec/**"] },
  }),
  role({
    id: "architect",
    kind: "core",
    mission: "Propose the architecture spine for the approved spec.",
    inputs: ["spec"],
    output: { artifacts: ["architecture"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict", "unknown"],
    reviewer: "security",
    models: both("top", "high"),
    tools: { profile: "write_scoped", write_paths: [".vtc/architecture/**"] },
  }),
  role({
    id: "designer",
    kind: "core",
    mission: "Design flows, screens and tokens for the approved spec.",
    inputs: ["spec"],
    output: { artifacts: ["design"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict", "unknown"],
    reviewer: "visual_qa",
    models: both("top"),
    tools: { profile: "write_scoped", write_paths: [".vtc/design/**"] },
  }),
  role({
    id: "planner",
    kind: "core",
    mission: "Split the approved design into tasks with intent contracts.",
    inputs: ["spec", "architecture"],
    output: { artifacts: ["tasks"], verdicts: [] },
    exits: ["done", "blocked", "spec_conflict", "unknown"],
    reviewer: "engine",
    models: both("top", "high"),
    tools: { profile: "read_only" },
  }),
  role({
    id: "qa",
    kind: "core",
    mission: "Author acceptance tests, or judge test adequacy.",
    inputs: ["spec"],
    output: { artifacts: [], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "read_only" },
    modes: {
      author: {
        output: {
          artifacts: ["acceptance_test", "hidden_acceptance_test", "scenario"],
          verdicts: [],
        },
        tools: { profile: "write_scoped", write_paths: ["tests/**"] },
      },
      judge: {
        output: { artifacts: [], verdicts: [...VERDICTS] },
        exits: ["done", "unknown"],
      },
    },
  }),
  role({
    id: "engineer",
    kind: "core",
    mission: "Implement the task inside its files_scope until the acceptance tests pass.",
    inputs: ["spec", "acceptance_test"],
    output: { artifacts: ["interface_contract"], verdicts: [] },
    exits: ["built", "blocked", "spec_conflict", "out_of_scope_fault"],
    reviewer: "qa",
    models: both("mid", "high"),
    tools: { profile: "code_sandboxed" },
  }),
  role({
    id: "spec_verifier",
    kind: "core",
    mission: "Judge one acceptance criterion against the built code, with evidence.",
    inputs: ["spec", "diff"],
    output: { artifacts: [], verdicts: [...VERDICTS] },
    exits: ["done", "unknown"],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "read_only" },
  }),
  role({
    id: "security",
    kind: "core",
    mission: "Threat-model the design, or verify the built diff.",
    inputs: ["spec"],
    output: { artifacts: [], verdicts: [] },
    exits: ["done", "unknown"],
    reviewer: "engine",
    models: both("top"),
    tools: { profile: "read_only" },
    modes: {
      design: {
        output: { artifacts: ["threat_model"], verdicts: [] },
        tools: { profile: "write_scoped", write_paths: [".vtc/architecture/**"] },
      },
      verify: { output: { artifacts: [], verdicts: [...VERDICTS] } },
    },
  }),
  role({
    id: "visual_qa",
    kind: "core",
    mission: "Judge the rendered UI against the design criteria V1–V8.",
    inputs: ["design_md"],
    output: { artifacts: [], verdicts: [...VERDICTS] },
    exits: ["done", "unknown"],
    reviewer: "engine",
    models: both("mid"),
    tools: { profile: "read_only" },
  }),
];

/** Advisors (§5.4), dispatched only through `consult` (spine §5 readings 25 and 30). */
export const FIXTURE_ADVISORS: readonly RoleContract[] = [
  role({
    id: "client_liaison",
    kind: "advisor",
    mission: "Write a client-facing export of the run's status.",
    inputs: ["run_status"],
    output: { artifacts: ["client_export"], verdicts: [] },
    exits: ["done", "blocked", "unknown"],
    reviewer: "human",
    models: both("mid"),
    tools: { profile: "write_scoped", write_paths: [".vtc/exports/**"] },
  }),
  role({
    id: "cost_analyst",
    kind: "advisor",
    mission: "Explain the run's spend and how to lower it.",
    inputs: ["cost_history"],
    output: { artifacts: [], verdicts: [] },
    exits: ["done", "unknown"],
    reviewer: "human",
    models: both("low"),
    tools: { profile: "read_only" },
  }),
];

/** Every fixture contract: what a compiled `vtc/role-contracts.json` would carry. */
export const ALL_FIXTURE_ROLES: readonly RoleContract[] = [...FIXTURE_ROLES, ...FIXTURE_ADVISORS];
