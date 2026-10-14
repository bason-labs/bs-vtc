/**
 * Integrator merge flags for the round-4 seams the cli wires by export name (merge note of
 * `src/automation-wiring.ts`; spine §5 readings 207 and 209). Each says whether this checkout is
 * expected to carry that seam: all are false on build/foundation, and the integrator sets one to
 * true in the merge that brings its branch in. The seam tests hold the lookups to these flags
 * exactly, so a seam that lands under the expected name fails until its flag is flipped, and a
 * flipped flag fails while the seam is missing, renamed, or no longer a function. Nothing here is
 * read at run time.
 */
export const ROUND4_LANDED: Readonly<
  Record<"plumbing" | "evidence" | "armPlugins" | "autoTemplates", boolean>
> = {
  /** team/engine-core: `git.createGitPlumbing` (`AutomationDeps.plumbing`). */
  plumbing: false,
  /** team/gate-runner: `gates.createEvidenceRecorder` (`AutomationDeps.evidence`). */
  evidence: false,
  /** team/roles-compiler: `createArmPluginCompiler` from `@vtc/compiler` (`EngineDeps.armPlugins`). */
  armPlugins: false,
  /**
   * team/roles-compiler: every compiled plugin carries `vtc/templates/{auto-pr,auto-issue,
   * changelog-entry}.md` (`AUTO_TEMPLATE_NAMES`, AD-27).
   */
  autoTemplates: false,
};
