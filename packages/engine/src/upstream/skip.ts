/**
 * Why an automatic action did not happen (AD-27 rule 7, D-ca). Every step of the upstream module
 * that decides not to act throws or returns one of these, and the orchestrator turns it into an
 * `automation.skipped` event. The detail never holds matched secret or project text.
 */
import type { AutomationSkipReason } from "@vtc/shared";

export class AutomationSkip extends Error {
  constructor(
    readonly reason: AutomationSkipReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "AutomationSkip";
  }
}

export const isAutomationSkip = (error: unknown): error is AutomationSkip =>
  error instanceof AutomationSkip;
