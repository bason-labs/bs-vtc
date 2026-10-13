/** Codex host adapter (§12.1). Implementation lands in sub-project 3. */
import type { HostCapabilities } from "@vtc/shared";

/** §12.1 / §20.4: no per-path write-deny, no background agents in the CLI, caps enforced by the engine only. */
export const codexCapabilities: HostCapabilities = {
  backgroundSubagents: false,
  perPathWriteDeny: false,
  headless: true,
  turnCap: false,
  budgetCap: false,
};
