import { ENGINE_HTTP, type G2Direction, type VtcEvent } from "@vtc/shared";
import { eventsOfType, webUrl } from "./events";
import { factStatusMeta } from "./facts";
import type { StatusMeta } from "./states";

/**
 * The human gates as the Lead showed them (spec §6.2, §8.2, §9.1; spine §5 reading 109): every
 * `gate.requested` event with its G2 design directions, the facts still unverified (each needs
 * a waiver with a reason, reading 110) and the DESIGN coverage check, then the decision
 * (`gate.approved` / `gate.rejected`). Approval happens in the Lead chat; this only shows it.
 */
export type GateOutcomeId = "pending" | "approved" | "rejected" | "superseded";

const OUTCOME: Readonly<Record<GateOutcomeId, StatusMeta>> = {
  pending: { label: "Waiting for approval in the Lead chat", tone: "accent", live: true },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "danger" },
  superseded: { label: "Asked again later", tone: "neutral" },
};

const NOVELTY: Readonly<Record<G2Direction["novelty"] | "unknown", StatusMeta>> = {
  novel: { label: "Novel", tone: "ok" },
  too_similar: { label: "Too similar to a past direction", tone: "warn" },
  unchecked: { label: "Novelty unchecked", tone: "warn" },
  unknown: { label: "Novelty not reported", tone: "neutral" },
};

export interface DirectionView {
  readonly id: string;
  readonly title: string;
  readonly thesis: string | null;
  readonly prototype: string | null;
  /** The first-viewport screenshot, under `.vtc/design/prototype/`. */
  readonly firstViewport: string | null;
  readonly novelty: StatusMeta;
  readonly chosen: boolean;
}

export interface GateFactView {
  readonly id: string;
  /** `null` when an older engine sent only the id. */
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly status: StatusMeta;
  readonly reason: string | null;
  readonly sourceUrl: string | null;
  /** The human's reason for waiving it, once given. */
  readonly waiver: string | null;
}

export interface GateRequestView {
  readonly seq: number;
  readonly at: string;
  readonly gates: string;
  readonly outcome: StatusMeta & { readonly id: GateOutcomeId };
  readonly decidedAt: string | null;
  readonly note: string | null;
  readonly artifacts: readonly string[];
  readonly directions: readonly DirectionView[];
  readonly facts: readonly GateFactView[];
  readonly coverage: { readonly ok: boolean; readonly problems: readonly string[] } | null;
}

const overlaps = (a: readonly string[], b: readonly string[]): boolean =>
  a.some((g) => b.includes(g));

/** Every gate request, newest first, with its outcome. */
export const gateRequests = (events: readonly VtcEvent[]): GateRequestView[] => {
  const requests = eventsOfType(events, "gate.requested");
  const approvals = eventsOfType(events, "gate.approved");
  const rejections = eventsOfType(events, "gate.rejected");
  const waivedEvents = eventsOfType(events, "fact.waived");
  return requests
    .map(({ event, data }): GateRequestView => {
      const approved = approvals.find(
        (a) => a.event.seq > event.seq && overlaps(a.data.gates, data.gates),
      );
      const rejected = rejections.find(
        (r) => r.event.seq > event.seq && overlaps(r.data.gates, data.gates),
      );
      const decision = [approved, rejected]
        .filter((d) => d !== undefined)
        .sort((a, b) => a.event.seq - b.event.seq)[0];
      const newer = requests.find(
        (r) => r.event.seq > event.seq && overlaps(r.data.gates, data.gates),
      );
      let outcome: GateOutcomeId = "pending";
      if (decision !== undefined && (newer === undefined || decision.event.seq < newer.event.seq)) {
        outcome = decision === approved ? "approved" : "rejected";
      } else if (newer !== undefined) {
        outcome = "superseded";
      }
      const decided = outcome === "approved" || outcome === "rejected" ? decision : undefined;
      const approval = outcome === "approved" ? approved?.data : undefined;
      const upTo = decided?.event.seq ?? Number.POSITIVE_INFINITY;
      const waivers = new Map<string, string | null>();
      for (const id of approval?.waived_facts ?? []) waivers.set(id, null);
      for (const w of waivedEvents) {
        if (w.event.seq > event.seq && w.event.seq <= upTo) waivers.set(w.data.id, w.data.reason);
      }
      for (const w of approval?.fact_waivers ?? []) waivers.set(w.id, w.reason);

      const details = new Map((data.directions ?? []).map((d) => [d.id, d]));
      const directionIds = data.directions?.map((d) => d.id) ?? data.design_directions;
      const facts = data.facts ?? [];
      const factIds = data.facts?.map((f) => f.id) ?? data.unverified_facts;
      const coverage = data.design_coverage;
      return {
        seq: event.seq,
        at: event.ts,
        gates: data.gates.join(" + "),
        outcome: { id: outcome, ...OUTCOME[outcome] },
        decidedAt: decided?.event.ts ?? null,
        note: decided?.data.note ?? null,
        artifacts: data.artifacts.map((a) => a.path),
        directions: directionIds.map((id) => {
          const d = details.get(id);
          return {
            id,
            title: d?.title ?? id,
            thesis: d?.thesis ?? null,
            prototype: d?.prototype ?? null,
            firstViewport: d?.first_viewport ?? null,
            novelty: NOVELTY[d?.novelty ?? "unknown"],
            chosen: approval?.design_direction === id,
          };
        }),
        facts: factIds.map((id) => {
          const f = facts.find((x) => x.id === id);
          return {
            id,
            subject: f?.subject ?? null,
            predicate: f?.predicate ?? null,
            status:
              f === undefined ? { label: "Unverified", tone: "danger" } : factStatusMeta(f.status),
            reason: f?.reason ?? null,
            sourceUrl: f?.source_url === undefined ? null : webUrl(f.source_url),
            waiver: waivers.get(id) ?? null,
          };
        }),
        coverage:
          coverage === undefined
            ? null
            : {
                ok: coverage.ok,
                problems: [
                  ...coverage.reqs_without_screen.map((r) => `${r} has no screen`),
                  ...coverage.screens_without_req.map((s) => `Screen ${s} covers no requirement`),
                  ...coverage.components_unregistered.map(
                    (c) => `Component ${c} is not registered`,
                  ),
                ],
              },
      };
    })
    .sort((a, b) => b.seq - a.seq);
};

/** The newest gate request still waiting for the human, or `null`. */
export const pendingGate = (events: readonly VtcEvent[]): GateRequestView | null =>
  gateRequests(events).find((g) => g.outcome.id === "pending") ?? null;

const PROTOTYPE_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/;

/**
 * A direction's prototype on the prototype origin (`HealthResult.prototype_url`), opened in its
 * own tab; `null` when the path is outside `.vtc/design/prototype/` or the result would leave
 * that loopback origin.
 */
export const directionPrototypeUrl = (prototypeUrl: string | null, path: string): string | null => {
  const root = ENGINE_HTTP.prototype.root;
  if (prototypeUrl === null || !path.startsWith(root)) return null;
  const rest = path.slice(root.length);
  if (rest === "" || /^[/\\]/.test(rest)) return null;
  let base: URL;
  let url: URL;
  try {
    base = new URL(prototypeUrl);
    url = new URL(rest, base);
  } catch {
    return null;
  }
  return PROTOTYPE_ORIGIN.test(base.origin) && url.origin === base.origin ? url.href : null;
};
