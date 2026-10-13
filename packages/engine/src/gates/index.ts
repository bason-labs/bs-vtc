/**
 * Gate Runner (AD-13; owner: gate-runner team, sub-project 2): calibration, baseline, layers
 * L0–L5, the L5 write-scope and test-integrity check, hidden tests, the pinned scanner store.
 * Implements `GateRunner` from @vtc/shared; the cli builds it with `createGateRunner` and injects
 * it into the daemon (AD-19). Exposes its public API from this file only and never imports
 * engine core, http or mcp. Git access goes through `../git/index.ts`.
 */
import type { CreateGateRunner } from "@vtc/shared";

export const createGateRunner: CreateGateRunner = () => {
  throw new Error("createGateRunner is not implemented yet (gate runner, sub-project 2)");
};
