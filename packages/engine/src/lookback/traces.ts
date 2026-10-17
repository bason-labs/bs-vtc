/**
 * Traces (AD-21): one dispatch (`role.dispatched`) joined with how it ended (`role.submitted`,
 * `role.rejected` or `role.failed`). Pure, over a run's events in log order.
 *
 * The prompt version of a trace is `PromptVersionRef`: the envelope's `prompt_sha` (effective),
 * the dispatch's `editable_sha256`, and the locked core's SHA from the compiled manifest
 * (`PluginManifestAgent.locked_sha256`, through `lockedShaFor`). A dispatch recorded before
 * contracts 4.5.0, or one whose locked SHA is unknown, has no version and Lookback skips it.
 */
import {
  isEventOfType,
  readEventData,
  sha256Hex,
  SlugSchema,
  splitForTrace,
  type HostId,
  type PromptVersionRef,
  type VtcEvent,
} from "@vtc/shared";

/** The locked core's SHA of a compiled agent, from the plugin manifest. */
export type LockedShaFor = (
  role: string,
  mode: string | undefined,
  host: HostId,
) => string | undefined;

export interface TraceEnd {
  readonly kind: "submitted" | "rejected" | "failed";
  readonly seq: number;
  /** `role.submitted.exit`. */
  readonly exit?: string;
  /** Input plus output tokens the host reported; `null` when it reported none. */
  readonly tokens: number | null;
}

export interface Trace {
  /** `role.dispatched.action_id`. */
  readonly trace: string;
  readonly run: string;
  readonly seq: number;
  readonly ts: string;
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  readonly task?: string;
  readonly feature?: string;
  readonly prompt?: PromptVersionRef;
  readonly canaryArm?: "candidate" | "baseline";
  readonly end?: TraceEnd;
}

const tokensOf = (event: VtcEvent): number | null =>
  event.tokens === null || event.tokens === undefined ? null : event.tokens.in + event.tokens.out;

/** Every dispatch of the events, in log order, with its end when the log has one. */
export const buildTraces = (events: readonly VtcEvent[], lockedShaFor: LockedShaFor): Trace[] => {
  const traces: Trace[] = [];
  const open = new Map<string, number>();
  for (const event of events) {
    if (isEventOfType(event, "role.dispatched")) {
      if (event.role === undefined || event.host === undefined) continue;
      const data = readEventData(event);
      const locked = lockedShaFor(event.role, data.mode, event.host);
      const prompt: PromptVersionRef | undefined =
        locked !== undefined && data.editable_sha256 !== undefined && event.prompt_sha !== undefined
          ? {
              role: event.role,
              ...(data.mode === undefined ? {} : { mode: data.mode }),
              host: event.host,
              locked_sha256: locked,
              editable_sha256: data.editable_sha256,
              effective_sha256: event.prompt_sha,
            }
          : undefined;
      open.set(`${event.run}:${data.action_id}`, traces.length);
      traces.push({
        trace: data.action_id,
        run: event.run,
        seq: event.seq,
        ts: event.ts,
        role: event.role,
        ...(data.mode === undefined ? {} : { mode: data.mode }),
        host: event.host,
        ...(event.task === undefined ? {} : { task: event.task }),
        ...(event.feature === undefined ? {} : { feature: event.feature }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(data.canary_arm === undefined ? {} : { canaryArm: data.canary_arm }),
      });
      continue;
    }
    let end: { actionId: string; end: TraceEnd } | undefined;
    if (isEventOfType(event, "role.submitted")) {
      const data = readEventData(event);
      end = {
        actionId: data.action_id,
        end: { kind: "submitted", seq: event.seq, exit: data.exit, tokens: tokensOf(event) },
      };
    } else if (isEventOfType(event, "role.rejected")) {
      end = {
        actionId: readEventData(event).action_id,
        end: { kind: "rejected", seq: event.seq, tokens: null },
      };
    } else if (isEventOfType(event, "role.failed")) {
      end = {
        actionId: readEventData(event).action_id,
        end: { kind: "failed", seq: event.seq, tokens: null },
      };
    }
    if (end === undefined) continue;
    const index = open.get(`${event.run}:${end.actionId}`);
    const trace = index === undefined ? undefined : traces[index];
    if (index === undefined || trace === undefined || trace.end !== undefined) continue;
    traces[index] = { ...trace, end: end.end };
  }
  return traces;
};

/** Same prompt target (role, mode, host). */
export const sameTarget = (
  a: { readonly role: string; readonly mode?: string | undefined; readonly host: string },
  b: { readonly role: string; readonly mode?: string | undefined; readonly host: string },
): boolean => a.role === b.role && a.mode === b.mode && a.host === b.host;

/** `role[-mode]@host`, a readable key of a target. */
export const targetKey = (t: {
  readonly role: string;
  readonly mode?: string | undefined;
  readonly host: string;
}): string => `${t.role}${t.mode === undefined ? "" : `-${t.mode}`}@${t.host}`;

/**
 * A trace's key across runs: `run:action_id`. Action ids restart in every run (`a-1`, `a-2`, …),
 * so a bare id names one dispatch per run, never one overall.
 */
export const traceRef = (t: { readonly run: string; readonly trace: string }): string =>
  `${t.run}:${t.trace}`;

/**
 * A trace's train or held-out split (AD-21 rule 6), by the hash of its cross-run key
 * ({@link traceRef}). Hashing the bare action id would fix the split per dispatch ordinal (`a-1`
 * is in every run), so the first dispatches of every run would never be train failures.
 */
export const traceSplit = (t: {
  readonly run: string;
  readonly trace: string;
}): "train" | "holdout" => splitForTrace(traceRef(t));

/**
 * The slug the lookback role reads and cites for a trace (`PromptProposal` `trace_ids`): the
 * run-qualified `<run>.<action_id>` when that is a slug, else `t-` and 16 hex of the
 * {@link traceRef}'s SHA-256. Unique across runs (action ids carry no dot).
 */
export const traceSlug = (t: { readonly run: string; readonly trace: string }): string => {
  const readable = `${t.run}.${t.trace}`;
  return SlugSchema.safeParse(readable).success
    ? readable
    : `t-${sha256Hex(traceRef(t)).slice(0, 16)}`;
};
