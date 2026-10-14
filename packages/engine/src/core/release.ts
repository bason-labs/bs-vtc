/**
 * RELEASE and RETRO (§6.1, §6.7): the feature evidence bundle, the PR marked ready with the bundle
 * in its description (Level 2), at Level 3 the auto-merge into main (`level3.ts`), then the run
 * summary. A Level-3 feature that parks, or a pause, leaves the run open: it finishes once the
 * feature ships, or the human takes it from there.
 */
import type { Kernel, RunHandle } from "./kernel.js";
import { pushFeature } from "./jobs.js";
import { autoMergeFeature } from "./level3.js";
import {
  bundleMarkdown,
  finalReviewScopeNote,
  finalReviewStepsRun,
  writeFeatureEvidenceBundle,
  writeRunSummary,
} from "./projections.js";
import { taskDetailView } from "./views.js";

export const startRelease = (k: Kernel, h: RunHandle, featureId: string): void => {
  k.spawn(h, `release:${featureId}`, async () => {
    const written = await k.serial(h, () =>
      Promise.resolve(
        writeFeatureEvidenceBundle(
          k.deps.repoRoot,
          h.state,
          featureId,
          "pass",
          k.now(),
          k.secrets(),
        ),
      ),
    );
    await pushFeature(
      k,
      h,
      featureId,
      true,
      written === null
        ? finalReviewScopeNote(finalReviewStepsRun(k.deps.repoRoot, h.state, featureId))
        : `${bundleMarkdown(written.bundle).trimEnd()}\n\n${finalReviewScopeNote(
            written.bundle.kind === "feature" ? written.bundle.final_review.steps_run : [],
          )}\n`,
    );
    if (h.state.run.merge_level_effective === 3) {
      // Level 3 (AD-23): the run finishes only once the feature shipped
      if ((await autoMergeFeature(k, h, featureId)) !== "merged") return;
    }
    await k.serial(h, () => {
      if (h.state.run.finished_at !== undefined) return Promise.resolve();
      k.emit(h, {
        type: "run.phase_changed",
        actor: "engine",
        data: { from: h.state.run.phase, to: "retro" },
      });
      const roleRuns = [...h.state.tasks.keys()].flatMap(
        (t) => taskDetailView(h.state, t)?.role_runs ?? [],
      );
      const summary = writeRunSummary(k.deps.repoRoot, h.state, roleRuns, k.secrets());
      k.emit(h, { type: "run.finished", actor: "engine", data: { outcome: "done", summary } });
      return Promise.resolve();
    });
  });
};
