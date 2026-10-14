/**
 * Proposals (spec §13 steps 1–2; AD-21 rule 4; AD-14 rule 4). The lookback role writes
 * `.vtc/lookback/proposals/<role>/editable.md` and `proposal.json` (`PromptProposal`); the engine
 * accepts one only when:
 * - it validates (at most `LOOKBACK_LIMITS.maxProposalChanges` changes, each with a hypothesis, a
 *   target metric and trace ids) and `editable.md` is exactly the proposed section;
 * - it is based on the role's current locked core and leaves it untouched: the locked core plus the
 *   proposed section must split back (`splitRolePrompt`) into the same locked core and section, so
 *   a section that smuggles in a prompt marker is refused;
 * - the section keeps the compiler's editable-section rules (`editableSectionErrors` from
 *   `@vtc/shared`: no mode block, no `{{placeholder}}`, no heading reserved for the task pack);
 * - nothing in it names an AD-9 marker (`findForbiddenInText`);
 * - every trace it cites (by its run-qualified slug, `traceSlug`) is an attributed train-split
 *   failure of that role that the history bears out (`trustedAttributions`; the role never sees
 *   held-out traces), run with the proposal's base version (same mode, host and hashes), so the
 *   base, which becomes the candidate's recorded `parent`, is a version that ran and failed. A
 *   change aimed at tokens (`target_metric` `tokens_per_success`) may also cite a train-split
 *   dispatch of the base that submitted, but only one a cost regression of the base names
 *   (`CostRegression.traces`, D-bv): its cost is the evidence. A held-out trace is never accepted;
 * - it actually changes the section;
 * - its id is new: the history records no `lookback.proposal_recorded` with that id. The id names
 *   the replay, its result file and its ledger rows, so a reused id would mix two candidates.
 * An accepted proposal becomes a candidate version file under the VTC home (immutable) and a
 * `lookback.proposal_recorded` event; promotion stays a human gesture.
 */
import {
  editableSectionErrors,
  findForbiddenInText,
  isEventOfType,
  LOOKBACK_REPO,
  PROMPT_MARKERS,
  PromptProposalSchema,
  readEventData,
  RoleIdSchema,
  splitRolePrompt,
  type Attribution,
  type PromptProposal,
  type PromptVersionFrontmatter,
  type PromptVersionRef,
} from "@vtc/shared";
import { join } from "node:path";
import {
  isTrainFailure,
  samePrompt,
  trustedAttributions,
  type AttributionHistory,
} from "./attribution.js";
import type { CostRegression } from "./cost-regression.js";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import { readRoleWrittenText } from "./files.js";
import { buildTraces, traceSlug, traceSplit } from "./traces.js";
import { promptVersionRef, sectionSha } from "./versions.js";

export type ProposalCheck =
  | { readonly ok: true; readonly proposal: PromptProposal; readonly candidate: PromptVersionRef }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Repo-relative paths of a role's proposal files. */
export const proposalPaths = (
  role: string,
): { readonly proposal: string; readonly editable: string } => {
  const dir = `${LOOKBACK_REPO.proposalsDir}/${RoleIdSchema.parse(role)}`;
  return { proposal: `${dir}/proposal.json`, editable: `${dir}/editable.md` };
};

/** The largest proposal file the engine reads (`proposal.json` or `editable.md`). */
export const PROPOSAL_FILE_MAX_BYTES = 256 * 1024;

/**
 * Reads a role's proposal files; `undefined` when either is missing. The directory is
 * role-writable, so a file that is not a regular file (a symbolic link) or is over
 * {@link PROPOSAL_FILE_MAX_BYTES} is never read: the result then carries the `problem` and no
 * proposal, which {@link checkProposal} refuses.
 */
export const readProposalFiles = async (
  projectRoot: string,
  role: string,
): Promise<
  { readonly raw: unknown; readonly editable: string; readonly problem?: string } | undefined
> => {
  const paths = proposalPaths(role);
  const json = await readRoleWrittenText(
    join(projectRoot, paths.proposal),
    PROPOSAL_FILE_MAX_BYTES,
  );
  const editable = await readRoleWrittenText(
    join(projectRoot, paths.editable),
    PROPOSAL_FILE_MAX_BYTES,
  );
  if (json.kind === "missing" || editable.kind === "missing") return undefined;
  if (json.kind === "refused") return { raw: undefined, editable: "", problem: json.problem };
  if (editable.kind === "refused")
    return { raw: undefined, editable: "", problem: editable.problem };
  try {
    return { raw: JSON.parse(json.text) as unknown, editable: editable.text };
  } catch {
    return { raw: undefined, editable: editable.text };
  }
};

/** Checks a proposal against the role's current locked core and the recorded attributions. */
export const checkProposal = (
  input: AttributionHistory & {
    readonly role: string;
    readonly raw: unknown;
    /** The content of `editable.md`. */
    readonly editableFile: string;
    /** The role's current locked core (`splitRolePrompt(...).locked`). */
    readonly locked: string;
    readonly attributions: readonly Attribution[];
    /**
     * The cost regressions of the history (`costRegressions`); a change aimed at tokens may cite
     * only the traces one of the base names. None: no success may be cited.
     */
    readonly costRegressions?: readonly CostRegression[];
  },
): ProposalCheck => {
  const parsed = PromptProposalSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "proposal"}: ${i.message}`),
    };
  }
  const proposal = parsed.data;
  const problems: string[] = [];
  const editable = proposal.editable.trim();
  if (proposal.base.role !== input.role)
    problems.push(`the proposal is for ${proposal.base.role}, not ${input.role}`);
  if (input.editableFile.trim() !== editable)
    problems.push("editable.md is not the proposed editable section");
  if (proposal.base.locked_sha256 !== sectionSha(input.locked)) {
    problems.push("the proposal is not based on the current locked core");
  }
  const composed = `${PROMPT_MARKERS.locked}\n${input.locked.trim()}\n${PROMPT_MARKERS.editable}\n${editable}\n`;
  const split = splitRolePrompt(composed);
  if (!split.ok || split.locked !== input.locked.trim() || split.editable !== editable) {
    problems.push(
      "the proposal touches the locked core or the prompt markers (a MAJOR change is a human edit)",
    );
  }
  // the compiler's rules for an editable section (no mode block, no placeholder, no reserved
  // heading; spine §5 reading 175): a section that would fail the compile is refused before replay
  problems.push(...editableSectionErrors(editable));
  const texts = [editable, ...proposal.changes.flatMap((c) => [c.hypothesis, c.summary])];
  for (const hit of texts.flatMap((t) => findForbiddenInText(t))) {
    problems.push(`names a forbidden marker (${hit.marker})`);
  }
  const ofRole = trustedAttributions(input.attributions, input).filter(
    (a) => a.prompt.role === input.role,
  );
  const trainFailures = ofRole.filter(isTrainFailure);
  const ofBase = new Set(
    trainFailures.filter((a) => samePrompt(a.prompt, proposal.base)).map(traceSlug),
  );
  const ofRoleAnyVersion = new Set(trainFailures.map(traceSlug));
  const dispatches = buildTraces(input.history, input.lockedShaFor).filter(
    (t) => t.role === input.role,
  );
  const heldOut = new Set(
    [...ofRole, ...dispatches].filter((t) => traceSplit(t) === "holdout").map(traceSlug),
  );
  // what a change aimed at tokens may cite besides failures: the base's train-split dispatches
  // that a cost regression of the base names
  const named = new Set(
    (input.costRegressions ?? [])
      .filter((r) => samePrompt(r.current, proposal.base))
      .flatMap((r) => r.traces.map((t) => t.id)),
  );
  const costEvidence = new Set(
    dispatches
      .filter(
        (t) =>
          t.prompt !== undefined &&
          samePrompt(t.prompt, proposal.base) &&
          t.end?.kind === "submitted" &&
          traceSplit(t) === "train",
      )
      .map(traceSlug)
      .filter((slug) => named.has(slug)),
  );
  for (const change of proposal.changes) {
    for (const trace of change.trace_ids) {
      if (heldOut.has(trace)) problems.push(`cites held-out trace ${trace}`);
      else if (ofBase.has(trace)) continue;
      else if (change.target_metric === "tokens_per_success" && costEvidence.has(trace)) continue;
      else if (!ofRoleAnyVersion.has(trace))
        problems.push(`cites ${trace}, which is not an attributed train failure of ${input.role}`);
      else problems.push(`cites ${trace}, which did not run with the proposal's base version`);
    }
  }
  if (sectionSha(editable) === proposal.base.editable_sha256)
    problems.push("the proposal does not change the section");
  if (
    input.history.some(
      (e) =>
        isEventOfType(e, "lookback.proposal_recorded") && readEventData(e).proposal === proposal.id,
    )
  )
    problems.push(`a proposal with id ${proposal.id} was already recorded: give this one a new id`);
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  const candidate = promptVersionRef({
    role: proposal.base.role,
    mode: proposal.base.mode,
    host: proposal.base.host,
    locked: input.locked,
    editable,
  });
  return { ok: true, proposal, candidate };
};

/** The candidate's version file frontmatter (its CHANGELOG entry, §13). */
export const candidateFrontmatter = (
  proposal: PromptProposal,
  candidate: PromptVersionRef,
  now: Date,
): PromptVersionFrontmatter => {
  const hypothesis = proposal.changes.map((c, i) => `${String(i + 1)}. ${c.hypothesis}`).join("\n");
  return {
    v: 1,
    version: candidate,
    parent: proposal.base.effective_sha256,
    proposal: proposal.id,
    changelog: {
      hypothesis: hypothesis.length > 2000 ? `${hypothesis.slice(0, 1999)}…` : hypothesis,
      trace_ids: [...new Set(proposal.changes.flatMap((c) => c.trace_ids))].slice(0, 50),
      evaluation: null,
    },
    created_at: now.toISOString(),
  };
};

/** `lookback.proposal_recorded` for an accepted proposal. */
export const proposalRecordedEvent = (role: string, proposal: PromptProposal): LookbackEventDraft =>
  lookbackEvent("lookback.proposal_recorded", {
    proposal: proposal.id,
    path: proposalPaths(role).proposal,
    changes: proposal.changes.length,
  });
