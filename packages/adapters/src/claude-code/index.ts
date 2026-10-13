/** Claude Code host adapter (§12.1). Implementation lands in sub-project 3. */
import type { HostCapabilities } from "@vtc/shared";

/** §12.1: plugin agents run in the background; `sandbox.filesystem.denyWrite`; `--max-turns`, `--max-budget-usd`. */
export const claudeCodeCapabilities: HostCapabilities = {
  subagents: true,
  backgroundSubagents: true,
  perPathWriteDeny: true,
  headless: true,
  turnCap: true,
  budgetCap: true,
};

export { statuslineIngestFromClaude } from "./statusline.js";
