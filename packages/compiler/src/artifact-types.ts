/**
 * The artifact types role contracts name (principle 2: prompts and ports name artifact types,
 * never roles or paths). The vocabulary is open in `@vtc/shared` (AD-3 rule 5); this list makes
 * the compiler's repo test catch a typo that would silently disconnect a port.
 *
 * Provisional: the engine routes artifacts by these names and cannot import this package (AD-1),
 * so the list is proposed to the integrator as a `KNOWN_ARTIFACT_TYPES` constant in @vtc/shared
 * (MINOR); once it lands this module re-exports it. No other package may rely on this copy.
 */
import { ACCEPTANCE_TESTS, HIDDEN_TESTS, PACK_INPUT_TYPES, TASKS_ARTIFACT } from "@vtc/shared";

export const KNOWN_ARTIFACT_TYPES: readonly string[] = [
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
  // advisors (§5.4): what the Lead's request to an advisor may list; the engine routes none of
  // these, because advisors run outside the run
  "cost_history",
  "change_request",
  "run_status",
  "attachments",
];
