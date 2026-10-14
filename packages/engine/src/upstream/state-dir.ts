/**
 * Where the automation keeps its state for VTC's own repo: `<vtcHome>/guard/_upstream/`. The ledger
 * there is read back as trusted (the heads VTC pushed, the head a supersede close deletes, the
 * issues the quiet sweep closed, the daily-cap fallback), and the cross-process locks and the gh
 * pacing log decide who writes when, so all of it sits under `guard/`, which
 * `ROLE_DENIED_VTC.homeWriteDeny` (`guard/**`) closes to every role. The engine's per-repo guard
 * dirs are named by a 16-hex repo key, so `_upstream` never collides with one. A project's own
 * ledger lives in that project's guard dir (`ledgerPath`).
 */
import { join } from "node:path";
import { GUARD_DIR } from "../core/index.js";

/** The directory below `<vtcHome>/guard/` that holds VTC's own repo's automation state. */
export const UPSTREAM_STATE_DIR = "_upstream";

/** `<vtcHome>/guard/_upstream`: the trusted root of VTC's own repo's automation state. */
export const upstreamStateDir = (vtcHome: string): string =>
  join(vtcHome, GUARD_DIR, UPSTREAM_STATE_DIR);
