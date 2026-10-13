/** Codex host adapter (§12.1). Implementation lands in sub-project 3. */
import type { HostCapabilities } from "@vtc/shared";

/**
 * §12.1 / §20.4: subagents are spawned explicitly (foreground), no background agents in the CLI,
 * no per-path write-deny, caps enforced by the engine only.
 */
export const codexCapabilities: HostCapabilities = {
  subagents: true,
  backgroundSubagents: false,
  perPathWriteDeny: false,
  headless: true,
  turnCap: false,
  budgetCap: false,
};
