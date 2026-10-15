/**
 * Lookback's routing step at RETRO (D-cn; spine §5 reading 219: "RETRO writes a routing
 * scorecard"). Engine core's daemon calls {@link lookbackRoutingStep} through its `RoutingLookback`
 * seam (`wireLookback(..., { propose, found })`) once the run's RETRO plan is made, and turns each
 * cell it returns into a `config` improvement fact (`routingConfigFact`) for the upstream module
 * (the AD-27 issue -> PR path; the PR changes only the values of `DEFAULT_ROUTING_TABLE`).
 *
 * The step recomputes the routing scorecard from the history (`computeRoutingScorecard`), writes it
 * at `LOOKBACK_REPO.routingScorecard` when it has a cell, and returns the cells
 * `routingProposals` backs (`routingProposalCells`). Its evidence is the scorecard: a tier replay
 * needs a tier arm that replay dispatch does not have yet (reading 218(7)), so none is planned here.
 */
import {
  DEFAULT_ROUTING_TABLE,
  engineRepoKey,
  type RoutingTable,
  type VtcEvent,
} from "@vtc/shared";
import { readAttributions } from "./attribution.js";
import {
  computeRoutingScorecard,
  routingProposalCells,
  routingProposals,
  writeRoutingScorecard,
  type RoutingProposalCell,
} from "./routing.js";
import { readTiebreakKeys } from "./tiebreaks.js";
import type { LockedShaFor } from "./traces.js";

export const lookbackRoutingStep = async (input: {
  readonly projectRoot: string;
  /** Every run's events as Lookback reads them (replay trials are left out either way). */
  readonly history: readonly VtcEvent[];
  readonly graderBundleSha: string;
  readonly now: Date;
  /**
   * Given, the trusted rows of `.vtc/lookback/attributions.jsonl` decide which dispatches failed
   * (`tokens_per_success`), as at the run's end; absent, a submitted dispatch counts as a success.
   */
  readonly lockedShaFor?: LockedShaFor;
  /** The VTC home whose recorded AI tiebreaks let an `ai_tiebreak` row count. */
  readonly vtcHome?: string;
  /** The table the runs routed with; default `DEFAULT_ROUTING_TABLE`. */
  readonly table?: RoutingTable;
}): Promise<RoutingProposalCell[]> => {
  const table = input.table ?? DEFAULT_ROUTING_TABLE;
  const tiebreaks =
    input.lockedShaFor === undefined || input.vtcHome === undefined
      ? undefined
      : await readTiebreakKeys(input.vtcHome, engineRepoKey(input.projectRoot));
  const attributions =
    input.lockedShaFor === undefined
      ? []
      : await readAttributions(input.projectRoot, {
          history: input.history,
          lockedShaFor: input.lockedShaFor,
          ...(tiebreaks === undefined ? {} : { tiebreaks }),
        });
  const card = computeRoutingScorecard({
    history: input.history,
    attributions,
    graderBundleSha: input.graderBundleSha,
    now: input.now,
    table,
  });
  if (card.cells.length === 0) return [];
  await writeRoutingScorecard(input.projectRoot, card);
  return routingProposalCells(routingProposals(card, table));
};
