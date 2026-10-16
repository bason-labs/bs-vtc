/**
 * The changed flow of an automatic UI PR (D-ct, D-ce; spine §5 reading 247(7)). The module picks
 * the flow from the head's `.vtc/design/flows.yaml` (`DESIGN_FLOWS_PATH`, read with
 * `parsePersisted` and `DesignFlowsFileSchema`) with `selectDesignFlow`: the first flow whose globs
 * match a path the change touches (`git diff --name-only base...head`), else the first that passes
 * a touched screen. Its id goes to the gate runner as `BeforeAfterRequest.flow`, and each side's
 * `flow_video` is captioned from `BeforeAfterResult.flow` (`scripted`, `idle` or `failed`). A
 * missing, unreadable, oversized or invalid flows file, or no matching flow, names no flow: the
 * gate runner then records the first screen, and the caption says so.
 *
 * The touched screens come from `PrSource.screens`. The daemon's bridge does not pass them yet
 * (an engine-core follow-up), so until it does a flow is selected by changed paths alone. The
 * flows file is untrusted input, so the globs are matched by {@link boundedFlowGlobMatch}, never
 * by a backtracking regular expression.
 */
import {
  DesignFlowsFileSchema,
  parsePersisted,
  selectDesignFlow,
  type BeforeAfterResult,
} from "@vtc/shared";
import { parseYaml } from "../../core/index.js";

/** The largest flows file the module reads (`FLOW_LIMITS` keeps a valid one far below it). */
export const FLOWS_FILE_MAX_BYTES = 256 * 1024;

/**
 * The most matching work (glob tokens times path characters) one flow selection may do. A
 * project's flows come nowhere near it; past it the selection stops and names no flow.
 */
export const FLOW_MATCH_BUDGET = 20_000_000;

/** One token of a glob, read as the engine's `globToRegExp` reads it. */
type GlobToken =
  | { readonly k: "lit"; readonly c: string }
  /** `*` (or a `**` inside a segment): `[^/]*` */
  | { readonly k: "seg" }
  /** `?`: `[^/]` */
  | { readonly k: "one" }
  /** `**` and a slash at a segment start: empty, or anything that ends in a slash */
  | { readonly k: "dirs" }
  /** a whole trailing `**` segment: `.*` */
  | { readonly k: "any" }
  /** `{a,b}`: one of the alternatives (core's braces do not nest) */
  | { readonly k: "alt"; readonly alts: readonly (readonly GlobToken[])[] };

/**
 * Pure: the tokens of a glob, by the same reading as core's `globToRegExp` (so a flow matches
 * exactly the paths the engine's `globMatch` would), or `undefined` for a glob whose expression
 * core could not build (nested or unclosed braces), which matches nothing.
 */
const globTokens = (glob: string): GlobToken[] | undefined => {
  const top: GlobToken[] = [];
  let group: GlobToken[][] | undefined;
  const out = (): GlobToken[] => group?.at(-1) ?? top;
  let i = 0;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        const atSegmentStart = i === 0 || glob.charAt(i - 1) === "/";
        const atSegmentEnd = i + 2 === glob.length || glob.charAt(i + 2) === "/";
        if (atSegmentStart && atSegmentEnd) {
          const dirs = glob.charAt(i + 2) === "/";
          out().push({ k: dirs ? "dirs" : "any" });
          i += dirs ? 3 : 2;
          continue;
        }
        out().push({ k: "seg" });
        i += 2;
        continue;
      }
      out().push({ k: "seg" });
    } else if (c === "?") out().push({ k: "one" });
    else if (c === "{") {
      if (group !== undefined) return undefined;
      group = [[]];
    } else if (c === "}" && group !== undefined) {
      top.push({ k: "alt", alts: group });
      group = undefined;
    } else if (c === "," && group !== undefined) group.push([]);
    else out().push({ k: "lit", c });
    i += 1;
  }
  return group === undefined ? top : undefined;
};

/** What a regular expression's `.` does not match. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Pure: the positions of `path` reachable after `tokens`, from `from` (ascending, distinct): a
 * set-of-states walk, so a match never backtracks and each token costs at most the path's length.
 * `spend` charges each step's work and throws once the budget is gone.
 */
const advance = (
  tokens: readonly GlobToken[],
  from: readonly number[],
  path: string,
  spend: (cost: number) => void,
): readonly number[] => {
  const n = path.length;
  let set = from;
  for (const token of tokens) {
    if (set.length === 0) return set;
    const next: number[] = [];
    let scanned = 0;
    switch (token.k) {
      case "lit":
      case "one":
        for (const p of set) {
          const c = path.charAt(p);
          if (p < n && (token.k === "lit" ? c === token.c : c !== "/")) next.push(p + 1);
        }
        break;
      case "seg":
      case "any": {
        // from each position on to the end of its segment (`seg`) or line (`any`)
        const stop = (c: string): boolean =>
          token.k === "seg" ? c === "/" : LINE_TERMINATOR.test(c);
        let reached = -1;
        for (const p of set) {
          if (p <= reached) continue;
          for (let q = p; ; q += 1) {
            next.push(q);
            reached = q;
            if (q === n || stop(path.charAt(q))) break;
          }
        }
        break;
      }
      case "dirs": {
        // stay, or move to any later position just past a `/`
        const first = set[0] ?? n;
        scanned = n - first;
        let i = 0;
        for (let q = first; q <= n; q += 1) {
          const stay = set[i] === q;
          if (stay) i += 1;
          if (stay || (q > first && path.charAt(q - 1) === "/")) next.push(q);
        }
        break;
      }
      case "alt": {
        const union = new Set<number>();
        for (const alt of token.alts) for (const q of advance(alt, set, path, spend)) union.add(q);
        next.push(...[...union].sort((x, y) => x - y));
        break;
      }
    }
    spend(set.length + next.length + scanned + 1);
    set = next;
  }
  return set;
};

/** Thrown when a flow selection runs out of {@link FLOW_MATCH_BUDGET}. */
class FlowMatchBudgetSpent extends Error {}

/**
 * The glob matcher a flow selection uses: the same matches as core's `globMatch`, without its
 * backtracking. The flows file is written by the run's agents (and anyone who pushes the head),
 * so a glob such as `**` repeated, or many `*`, must not stall the daemon on a deep path: each
 * match costs at most tokens times path length, and all of a selection's matches share `budget`.
 */
export const boundedFlowGlobMatch = (
  budget: number = FLOW_MATCH_BUDGET,
): ((glob: string, path: string) => boolean) => {
  let left = budget;
  const spend = (cost: number): void => {
    left -= cost;
    if (left < 0) throw new FlowMatchBudgetSpent("the flow selection's matching budget is spent");
  };
  const tokens = new Map<string, GlobToken[] | undefined>();
  return (glob, path) => {
    if (!tokens.has(glob)) tokens.set(glob, globTokens(glob));
    const parsed = tokens.get(glob);
    if (parsed === undefined) return false;
    return advance(parsed, [0], path, spend).includes(path.length);
  };
};

/**
 * The caption of a `flow_video` of a flow the PR asked for that the gate runner did not report
 * scripting (a recorder before contracts 5.7.0 records the first screen, as it always did).
 */
export const FIRST_SCREEN_ALT = "First rendered screen, loading then idle";

/**
 * The caption of a `flow_video` when no flow was selected for the change: the gate runner
 * recorded the side's first rendered screen loading and then left idle. Never "the changed flow".
 */
export const BEFORE_AFTER_FLOW_ALT = `${FIRST_SCREEN_ALT} (no scripted flow matches this change)`;

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
  /** The matching work the selection may do (default {@link FLOW_MATCH_BUDGET}). */
  readonly matchBudget?: number | undefined;
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
  try {
    return selectDesignFlow(
      file.data,
      { changedPaths, ...(input.screens === undefined ? {} : { screens: input.screens }) },
      boundedFlowGlobMatch(input.matchBudget),
    )?.id;
  } catch {
    // the matching budget is spent: name no flow rather than stall
    return undefined;
  }
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
 * (`-before` / `-after`). No flow asked for: {@link BEFORE_AFTER_FLOW_ALT}. A flow asked for but
 * a report of another flow, or none: {@link FIRST_SCREEN_ALT}, which claims no reason. A video of
 * no known side is captioned by the report alone when both sides agree, else by both sides.
 */
export const flowVideoAlt = (
  requested: string | undefined,
  flow: BeforeAfterResult["flow"],
  side: "before" | "after" | undefined,
): string => {
  const suffix = side === undefined ? "" : ` (${side})`;
  if (requested === undefined) return `${BEFORE_AFTER_FLOW_ALT}${suffix}`;
  if (flow === undefined || flow.id !== requested) return `${FIRST_SCREEN_ALT}${suffix}`;
  if (side === undefined)
    return flow.before === flow.after
      ? sideCaption(requested, flow.before)
      : `A recording of the changed flow "${requested}" (before: ${flow.before}, after: ${flow.after})`;
  return `${sideCaption(requested, flow[side])}${suffix}`;
};
