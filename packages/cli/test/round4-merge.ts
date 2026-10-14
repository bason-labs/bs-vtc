/**
 * Integrator merge flags for the round-4 seams the cli wires by export name (merge note of
 * `src/automation-wiring.ts`; spine §5 readings 207 and 209). Each says whether this checkout is
 * expected to carry that seam: the integrator set each one to true in the round-4 merge that
 * brought its branch in. The seam tests hold the lookups to these flags
 * exactly, so a seam that lands under the expected name fails until its flag is flipped, and a
 * flipped flag fails while the seam is missing, renamed, or no longer a function. Nothing here is
 * read at run time.
 */
export const ROUND4_LANDED: Readonly<
  Record<"plumbing" | "evidence" | "armPlugins" | "autoTemplates" | "replayGrader", boolean>
> = {
  /** team/engine-core: `git.createGitPlumbing` (`AutomationDeps.plumbing`). */
  plumbing: true,
  /** team/gate-runner: `gates.createEvidenceRecorder` (`AutomationDeps.evidence`). */
  evidence: true,
  /** team/roles-compiler: `createArmPluginCompiler` from `@vtc/compiler` (`EngineDeps.armPlugins`). */
  armPlugins: true,
  /**
   * team/roles-compiler: every compiled plugin carries `vtc/templates/{auto-pr,auto-issue,
   * changelog-entry}.md` (`AUTO_TEMPLATE_NAMES`, AD-27).
   */
  autoTemplates: true,
  /**
   * team/engine-core: `core.replayGraderOf`, the grader engine core's replay gate, trial
   * submission and daemon take a replay's grader from (`replayGraderFor`, reading 209(2)).
   */
  replayGrader: true,
};
