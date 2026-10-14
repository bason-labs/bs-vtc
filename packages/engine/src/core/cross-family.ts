/**
 * Cross-family review (spec §12.4, D10; spine AD-17 rules 2, 4 and 5): on a high-risk task, when
 * the project opts in (`hosts.cross_family_review`) and both host families are installed, a
 * read-only reviewer from the other family runs as an engine-launched headless run. It needs
 * `headless_allowed` (`planDispatch("cross_family_review")`); without it the review is
 * unavailable and skipped. Capped at the task's first two rounds; it costs both quotas.
 */
import { HOST_IDS, planDispatch, type HostId, type Task } from "@vtc/shared";
import type { Kernel, RunHandle } from "./kernel.js";

/** The rounds of a task that get a cross-family review (§12.4: "capped at 1–2 rounds"). */
export const CROSS_FAMILY_MAX_ROUND = 2;

/** The host the task's cross-family reviewer runs on, or `undefined` when it gets none. */
export const crossFamilyHost = (
  k: Kernel,
  h: RunHandle,
  task: Pick<Task, "risk" | "round">,
): HostId | undefined => {
  const config = k.config();
  if (!config.hosts.cross_family_review || task.risk !== "high") return undefined;
  if (Math.max(1, task.round) > CROSS_FAMILY_MAX_ROUND) return undefined;
  const primary = k.liveLeadHost(h.state.id) ?? k.hostFor({ host: null });
  const other = HOST_IDS.find((x) => x !== primary && k.deps.adapters[x] !== undefined);
  if (other === undefined) return undefined;
  const capabilities = k.deps.adapters[other]?.capabilities ?? {
    subagents: false,
    headless: false,
  };
  return planDispatch("cross_family_review", config.hosts.dispatch, capabilities) === "headless"
    ? other
    : undefined;
};
