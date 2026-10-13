/**
 * Budget controller (§11; AD-8 rules 1 and 5). Pure. Unit: list-price-equivalent USD. Initial
 * task budgets come from `project.yaml` by size (S $1.50, M $5, L $15 by default); within a task
 * the Engineer may spend at most 45% and all reviewers together at most 25% (over its share the
 * Engineer is not dispatched again and the task parks; over theirs the reviewers drop one tier);
 * at 70% the reviewers drop one tier; at 100% the task finishes its current turn and parks with
 * evidence; there are no automatic raises, and a human may raise a budget to at most 2× (§6.5).
 */
import { MAX_BUDGET_RAISE_FACTOR, type ProjectConfig, type TaskSize } from "@vtc/shared";

/** At this share of its budget a task's reviewers drop one model tier (§11). */
export const REVIEWER_DROP_SHARE = 0.7;

/** Shares within a task (§11): Engineer at most 45%, all reviewers at most 25%. */
export const TASK_SHARES = { engineer: 0.45, reviewers: 0.25 } as const;

/** Priced spend of a task's runs by share (unpriced runs count 0 here; they are flagged in the summary). */
export interface ShareSpend {
  readonly engineer: number;
  readonly reviewers: number;
}

/** Which shares a task has used up (spend strictly over its share of the budget). */
export const sharesExceeded = (
  spend: ShareSpend,
  budget: number,
): { readonly engineer: boolean; readonly reviewers: boolean } => ({
  engineer: spend.engineer > budget * TASK_SHARES.engineer,
  reviewers: spend.reviewers > budget * TASK_SHARES.reviewers,
});

export const taskBudgetFor = (size: TaskSize, config: Pick<ProjectConfig, "budgets">): number =>
  config.budgets.task_usd[size];

export type BudgetState = "ok" | "reviewers_drop" | "exhausted";

export const budgetState = (spent: number, budget: number): BudgetState => {
  if (spent >= budget) return "exhausted";
  if (spent >= budget * REVIEWER_DROP_SHARE) return "reviewers_drop";
  return "ok";
};

export class BudgetRaiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetRaiseError";
  }
}

/**
 * A human raise (§6.5 "raise the budget (2× maximum)"): the new budget is `factor` × the
 * original budget, never more than 2× the original, never automatic.
 */
export const raisedBudget = (original: number, current: number, factor: number): number => {
  if (!(factor > 1) || factor > MAX_BUDGET_RAISE_FACTOR) {
    throw new BudgetRaiseError(`a raise factor must be in (1, ${String(MAX_BUDGET_RAISE_FACTOR)}]`);
  }
  const raised = Math.min(original * factor, original * MAX_BUDGET_RAISE_FACTOR);
  return Math.max(raised, current);
};

/** Rounds a dollar amount to 1/10000 so float noise never leaks into the log. */
export const usd = (value: number): number => Math.round(value * 10_000) / 10_000;
