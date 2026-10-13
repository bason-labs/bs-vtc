/**
 * Reviewers and triage (§6.3 steps 7–8): once every reviewer the Risk Router attached has reported
 * on the built head, triage turns their findings and verdicts into the round's outcome. Triage is
 * a job, so it also runs when a task resumes into `verifying` with its reviews already in.
 */
import type { Finding } from "@vtc/shared";
import { resolves, type EvidenceContext } from "./evidence.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { isReviewer, lastBuilt } from "./queries.js";
import { frozenSpecItems, taskAcceptanceCriteria } from "./read-model.js";
import { loadResult } from "./results.js";
import { reviewersFor, VISUAL_QA_CALLS } from "./router.js";
import type { RoleRunRecord } from "./state.js";
import { findingFromDraft, findingFromVerdict } from "./triage.js";
import { recordRoundFindings, settleRound } from "./verify.js";

export { isReviewer };

/** Resolves evidence against a commit (or the working tree), the frozen spec and git. */
export const evidenceContext = (k: Kernel, h: RunHandle, head: string | null): EvidenceContext => ({
  repoRoot: k.deps.repoRoot,
  git: k.deps.git,
  head,
  specIds: frozenSpecItems(k.deps.repoRoot, h.state).map((i) => i.id),
  commitExists: async (sha) => {
    try {
      await k.deps.workspace.resolve(sha);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * The reviewer runs accepted for the task's built head, when every attached slot reported. A task
 * the router attaches no reviewer to (an engine-created task with no ACs, low risk, no UI) is
 * complete with no runs, so triage settles its round on the gates alone.
 */
export const completedReviews = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
): RoleRunRecord[] | null => {
  const task = h.state.tasks.get(taskId);
  const built = lastBuilt(h.state, taskId);
  if (task === undefined || built === undefined) return null;
  const since = built.closedSeq ?? 0;
  const slots = reviewersFor(
    task,
    h.state.run,
    taskAcceptanceCriteria(k.deps.repoRoot, h.state, taskId),
  );
  const runs = [...h.state.roleRuns.values()].filter(
    (r) =>
      r.task === taskId && isReviewer(r) && r.status === "submitted" && (r.closedSeq ?? 0) > since,
  );
  const complete = slots.every((slot) =>
    slot.role === "visual_qa"
      ? runs.filter((r) => r.role === "visual_qa").length >= VISUAL_QA_CALLS
      : runs.some(
          (r) => r.role === slot.role && r.mode === slot.mode && r.subject === slot.subject,
        ),
  );
  return complete ? runs : null;
};

/** The round's findings from its reviews (evidence checked; failing verdicts without findings). */
const reviewFindings = async (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  runs: readonly RoleRunRecord[],
  head: string,
): Promise<Finding[]> => {
  const round = Math.max(1, h.state.tasks.get(taskId)?.round ?? 1);
  const ctx = evidenceContext(k, h, head);
  const fallbackPath = `.vtc/tasks/${taskId}.md`;
  const fresh: Finding[] = [];
  for (const r of runs) {
    const result = loadResult(k.deps.repoRoot, r.action_id);
    if (result === undefined) continue;
    const drafts = result.findings.map((d) => findingFromDraft(d, r.role, { task: taskId, round }));
    for (const f of drafts)
      fresh.push((await resolves(ctx, f.evidence)) ? f : { ...f, status: "discarded" });
    if (r.role !== "visual_qa" && drafts.length === 0) {
      for (const v of result.verdicts) {
        if (v.verdict !== "pass")
          fresh.push(findingFromVerdict(v, r.role, { task: taskId, round, fallbackPath }));
      }
    }
  }
  // Visual QA: three calls, a 2-of-3 vote per criterion (AD-8 rule 2).
  const visual = runs
    .filter((r) => r.role === "visual_qa")
    .flatMap((r) => loadResult(k.deps.repoRoot, r.action_id)?.verdicts ?? []);
  for (const subject of [...new Set(visual.map((v) => v.subject))]) {
    const failing = visual.filter((v) => v.subject === subject && v.verdict !== "pass");
    const first = failing[0];
    if (failing.length >= 2 && first !== undefined) {
      fresh.push(findingFromVerdict(first, "visual_qa", { task: taskId, round, fallbackPath }));
    }
  }
  return fresh;
};

/** Triage the round once its reviews are complete (a job keyed per task). */
export const startTriage = (k: Kernel, h: RunHandle, taskId: string): void => {
  k.spawn(h, `triage:${taskId}`, async () => {
    const runs = completedReviews(k, h, taskId);
    const head = lastBuilt(h.state, taskId)?.head;
    if (runs === null || head === undefined) return;
    const fresh = await reviewFindings(k, h, taskId, runs, head);
    await k.serial(h, () => {
      if (
        h.state.tasks.get(taskId)?.status !== "verifying" ||
        lastBuilt(h.state, taskId)?.head !== head
      ) {
        return Promise.resolve();
      }
      const merge = recordRoundFindings(k, h, taskId, fresh, new Set(runs.map((r) => r.role)));
      settleRound(k, h, taskId, merge);
      return Promise.resolve();
    });
  });
};
