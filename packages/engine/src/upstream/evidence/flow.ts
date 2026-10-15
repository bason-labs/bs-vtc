/**
 * The changed flow of an automatic UI PR (D-ct, D-ce; spine §5 reading 247(7)). The module picks
 * the flow from the head's `.vtc/design/flows.yaml` (`DESIGN_FLOWS_PATH`, read with
 * `parsePersisted` and `DesignFlowsFileSchema`) with `selectDesignFlow`: the first flow whose globs
 * match a path the change touches (`git diff --name-only base...head`), else the first that passes
 * a touched screen. Its id goes to the gate runner as `BeforeAfterRequest.flow`, and each side's
 * `flow_video` is captioned from `BeforeAfterResult.flow` (`scripted`, `idle` or `failed`). A
 * missing, unreadable, oversized or invalid flows file, or no matching flow, names no flow: the
 * gate runner then records the first screen, and the caption says so.
 */
import {
  DesignFlowsFileSchema,
  parsePersisted,
  selectDesignFlow,
  type BeforeAfterResult,
} from "@vtc/shared";
import { globMatch, parseYaml } from "../../core/index.js";

/** The largest flows file the module reads (`FLOW_LIMITS` keeps a valid one far below it). */
export const FLOWS_FILE_MAX_BYTES = 256 * 1024;

/**
 * The caption of a `flow_video` that shows no scripted flow: the gate runner recorded the side's
 * first rendered screen loading and then left idle (no flow was selected for the change, or the
 * recorder did not say what it scripted). Never "the changed flow".
 */
export const BEFORE_AFTER_FLOW_ALT =
  "First rendered screen, loading then idle (no scripted flow matches this change)";

/**
 * The id of the flow an automatic UI PR records (`BeforeAfterRequest.flow`), or `undefined`. Any
 * failure to read or parse the flows file names no flow; a failure to list the changed paths
 * leaves only the touched screens to select by. Never throws.
 */
export const changedFlow = async (input: {
  /** The head's `DESIGN_FLOWS_PATH` bytes (`undefined`: no such file at the head). */
  readonly readFlowsFile: () => Promise<Uint8Array | undefined>;
  /** The paths the head changes against the PR's base (`GitPlumbing.changedPaths`). */
  readonly changedPaths: () => Promise<readonly string[]>;
  /** Screen ids (`screens.yaml`) the change touches, when the caller knows them. */
  readonly screens?: readonly string[] | undefined;
}): Promise<string | undefined> => {
  let text: string;
  try {
    const bytes = await input.readFlowsFile();
    if (bytes === undefined || bytes.byteLength > FLOWS_FILE_MAX_BYTES) return undefined;
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return undefined;
  }
  const file = parsePersisted(DesignFlowsFileSchema, raw);
  if (!file.success) return undefined;
  let changedPaths: readonly string[];
  try {
    changedPaths = await input.changedPaths();
  } catch {
    changedPaths = [];
  }
  return selectDesignFlow(
    file.data,
    { changedPaths, ...(input.screens === undefined ? {} : { screens: input.screens }) },
    globMatch,
  )?.id;
};

type FlowSide = "scripted" | "idle" | "failed";

const sideCaption = (id: string, status: FlowSide): string => {
  switch (status) {
    case "scripted":
      return `The changed flow "${id}", scripted`;
    case "idle":
      return `First rendered screen, loading then idle: this side has no flow "${id}"`;
    case "failed":
      return `The changed flow "${id}" up to the step that failed`;
  }
};

/**
 * Pure: the caption of one `flow_video` (D-ct; reading 247(7)). `requested` is the flow the PR
 * asked for, `flow` what the gate runner reports, and `side` the side the video's name says
 * (`-before` / `-after`). A report of another flow, or none, keeps the first-screen caption; a
 * video of no known side is captioned by the report only when both sides agree.
 */
export const flowVideoAlt = (
  requested: string | undefined,
  flow: BeforeAfterResult["flow"],
  side: "before" | "after" | undefined,
): string => {
  const suffix = side === undefined ? "" : ` (${side})`;
  if (requested === undefined || flow === undefined || flow.id !== requested)
    return `${BEFORE_AFTER_FLOW_ALT}${suffix}`;
  if (side === undefined)
    return flow.before === flow.after ? sideCaption(requested, flow.before) : BEFORE_AFTER_FLOW_ALT;
  return `${sideCaption(requested, flow[side])}${suffix}`;
};
