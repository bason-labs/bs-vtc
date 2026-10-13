/**
 * The artifact types role contracts, packs and results name today (principle 2: prompts and
 * ports name artifact types, never roles or paths). The vocabulary stays open (AD-3 rule 5):
 * `ArtifactTypeSchema` accepts any slug and consumers ignore types they do not know. This list
 * lets the compiler's repo test catch a typo that would silently disconnect a port, and lets the
 * engine route by name without importing the compiler (AD-1). Adding a type is MINOR.
 */
import { ACCEPTANCE_TESTS, HIDDEN_TESTS } from "./gate-result.js";
import { TASKS_ARTIFACT } from "./helpers/conformance.js";
import { PACK_INPUT_TYPES } from "./task-pack.js";

export const KNOWN_ARTIFACT_TYPES = [
  // what the Context Packer puts in every pipeline's packs
  ...Object.values(PACK_INPUT_TYPES),
  // DISCOVER and SPECIFY
  "repo_map",
  "research_brief",
  "facts",
  "spec",
  // DESIGN
  "architecture",
  "design_note",
  "threat_model",
  "design_flows",
  "screens",
  "prototype",
  "design_tokens",
  "component_specs",
  // PLAN and BUILD
  TASKS_ARTIFACT,
  "task",
  ACCEPTANCE_TESTS.artifactType,
  HIDDEN_TESTS.artifactType,
  "scenario_card",
  "diff",
  // verification evidence the engine produces
  "gate_report",
  "traceability_report",
  "acceptance_criterion",
  "test_results",
  "findings",
  "screenshots",
  "visual_report",
  // Lookback
  "traces",
  "scorecard",
  "prompt_proposal",
  // advisor inputs and outputs (§5.4, through `consult`)
  "cost_history",
  "change_request",
  "run_status",
  "attachments",
  "client_export",
] as const;
export type KnownArtifactType = (typeof KNOWN_ARTIFACT_TYPES)[number];

export const isKnownArtifactType = (type: string): type is KnownArtifactType =>
  (KNOWN_ARTIFACT_TYPES as readonly string[]).includes(type);
