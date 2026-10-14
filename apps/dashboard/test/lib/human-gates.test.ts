import { describe, expect, it } from "vitest";
import { directionPrototypeUrl, gateRequests, pendingGate } from "@/lib/human-gates";
import { firstSample, sampleEvent, variant } from "../golden-samples";

/** The golden G2 request, the human's waiver of its fact, and an approval of `ledger`. */
const request = firstSample("gate.requested");
const frozen = (request.data as { artifacts: unknown[] }).artifacts;
const approved = sampleEvent(30, "gate.approved", {
  gates: ["G2"],
  frozen,
  design_direction: "ledger",
  waived_facts: ["f-0123456789abcdef"],
});
const GATE_EVENTS = [request, firstSample("fact.waived"), approved];

describe("gateRequests (gate.requested, spine §5 reading 109)", () => {
  it("shows the G2 directions with novelty, the chosen one and the first viewport", () => {
    const [g2] = gateRequests(GATE_EVENTS);
    expect(g2?.gates).toBe("G2");
    expect(g2?.outcome).toMatchObject({ id: "approved", label: "Approved" });
    expect(g2?.directions.map((d) => [d.id, d.title, d.novelty.label, d.chosen])).toEqual([
      ["ledger", "Quiet ledger", "Novel", true],
      ["signal", "Signal", "Too similar to a past direction", false],
    ]);
    expect(g2?.directions[0]?.firstViewport).toBe(".vtc/design/prototype/ledger/first.png");
  });

  it("lists every unverified fact with why, and the waiver reason given for it", () => {
    const [g2] = gateRequests(GATE_EVENTS);
    expect(g2?.facts.map((f) => [f.id, f.status.label, f.reason, f.waiver])).toEqual([
      [
        "f-0123456789abcdef",
        "Unverified",
        "no source: only a host search result reported it",
        "MIT confirmed by legal from the package's LICENSE file",
      ],
    ]);
    expect(g2?.facts[0]?.sourceUrl).toBe("https://www.npmjs.com/package/papaparse");
  });

  it("explains the design coverage check", () => {
    expect(gateRequests(GATE_EVENTS)[0]?.coverage).toEqual({ ok: true, problems: [] });
    const gaps = variant(request, 31, {
      design_coverage: {
        reqs_without_component: ["REQ-5"],
        reqs_without_screen: ["REQ-4"],
        screens_without_req: [],
        components_unregistered: ["date-picker"],
        ok: false,
      },
    });
    const [g2] = gateRequests([gaps]);
    expect(g2?.coverage).toEqual({
      ok: false,
      problems: [
        "REQ-5 is mapped to no component",
        "REQ-4 has no screen",
        "Component date-picker is not registered",
      ],
    });
  });

  it("shows too few design directions (D-bt) as a blocking notice, not a coverage gap", () => {
    const few = sampleEvent(73, "gate.requested", {
      gates: ["G2"],
      artifacts: frozen,
      design_coverage: {
        reqs_without_component: [],
        reqs_without_screen: [],
        screens_without_req: [],
        components_unregistered: [],
        directions_problem: "1 design direction after the Designer's re-dispatch; G2 needs 2–3",
        ok: false,
      },
    });
    const [view] = gateRequests([few]);
    expect(view?.blocking).toBe(
      "1 design direction after the Designer's re-dispatch; G2 needs 2–3",
    );
    expect(view?.coverage).toEqual({ ok: false, problems: [] });
    const [plain] = gateRequests(GATE_EVENTS);
    expect(plain?.blocking).toBeNull();
  });

  it("is pending until a decision on the same gate, and a newer request supersedes it", () => {
    expect(pendingGate([request])?.outcome.id).toBe("pending");
    expect(pendingGate(GATE_EVENTS)).toBeNull();
    const again = sampleEvent(70, "gate.requested", { gates: ["G2"], artifacts: frozen });
    const views = gateRequests([request, again]);
    expect(views.map((v) => v.outcome.id)).toEqual(["pending", "superseded"]);
    const g1 = sampleEvent(71, "gate.rejected", { gates: ["G1"], note: "spec unclear" });
    expect(pendingGate([request, g1])?.outcome.id).toBe("pending");
  });

  it("stops waiting once the run finished without a decision", () => {
    const finished = sampleEvent(72, "run.finished", { outcome: "aborted" });
    const [view] = gateRequests([request, finished]);
    expect(view?.outcome).toMatchObject({
      id: "unanswered",
      label: "Not decided before the run ended",
    });
    expect(view?.outcome.live).toBeUndefined();
    expect(pendingGate([request, finished])).toBeNull();
  });

  it("shows a rejection with its note", () => {
    const rejected = sampleEvent(72, "gate.rejected", {
      gates: ["G2"],
      note: "Try a third direction",
    });
    const [view] = gateRequests([request, rejected]);
    expect(view?.outcome).toMatchObject({ id: "rejected", tone: "danger" });
    expect(view?.note).toBe("Try a third direction");
  });

  it("shows the design exit the human took: a re-roll or the category standard (reading 151)", () => {
    const rerolled = sampleEvent(72, "gate.rejected", { gates: ["G2"], design_exit: "re_roll" });
    const [view] = gateRequests([request, rerolled]);
    expect(view?.designExit).toBe("Re-rolled: only the Designer works again");
    const standard = sampleEvent(72, "gate.approved", {
      gates: ["G2"],
      frozen,
      design_exit: "category_standard",
    });
    const [taken] = gateRequests([request, standard]);
    expect(taken?.designExit).toBe("Category standard: no distinct direction");
    expect(taken?.directions.every((d) => !d.chosen)).toBe(true);
    expect(gateRequests(GATE_EVENTS)[0]?.designExit).toBeNull();
  });

  it("falls back to the ids when an older engine sent no details", () => {
    const bare = sampleEvent(73, "gate.requested", {
      gates: ["G2"],
      artifacts: frozen,
      design_directions: ["ledger"],
      unverified_facts: ["f-0123456789abcdef"],
    });
    const [view] = gateRequests([bare]);
    expect(view?.directions[0]).toMatchObject({ id: "ledger", title: "ledger" });
    expect(view?.directions[0]?.novelty.label).toBe("Novelty not reported");
    expect(view?.facts[0]).toMatchObject({ id: "f-0123456789abcdef", subject: null });
    expect(view?.coverage).toBeNull();
  });
});

describe("directionPrototypeUrl", () => {
  it("opens a direction on the prototype origin", () => {
    expect(
      directionPrototypeUrl(
        "http://127.0.0.1:4311/",
        ".vtc/design/prototype/calm-ledger/index.html",
      ),
    ).toBe("http://127.0.0.1:4311/calm-ledger/index.html");
  });

  it("refuses paths outside the prototype root and non-loopback origins", () => {
    expect(directionPrototypeUrl("http://127.0.0.1:4311/", ".vtc/spec/spec.md")).toBeNull();
    expect(
      directionPrototypeUrl("http://127.0.0.1:4311/", ".vtc/design/prototype///evil.example/x"),
    ).toBeNull();
    expect(
      directionPrototypeUrl("https://example.com/", ".vtc/design/prototype/a.html"),
    ).toBeNull();
    expect(directionPrototypeUrl(null, ".vtc/design/prototype/a.html")).toBeNull();
  });
});
