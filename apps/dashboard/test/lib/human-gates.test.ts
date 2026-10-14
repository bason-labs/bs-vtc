import { describe, expect, it } from "vitest";
import { directionPrototypeUrl, gateRequests, pendingGate } from "@/lib/human-gates";
import { GATE_EVENTS, SHA256, w3Event } from "../wave3-fixtures";

const request = GATE_EVENTS[0]!;
const frozen = [{ path: ".vtc/architecture/spine.md", sha256: SHA256("3") }];

describe("gateRequests (gate.requested, spine §5 reading 109)", () => {
  it("shows the G2 directions with novelty, the chosen one and the first viewport", () => {
    const [g2] = gateRequests(GATE_EVENTS);
    expect(g2?.gates).toBe("G2");
    expect(g2?.outcome).toMatchObject({ id: "approved", label: "Approved" });
    expect(g2?.directions.map((d) => [d.id, d.novelty.label, d.chosen])).toEqual([
      ["calm-ledger", "Novel", true],
      ["night-shift", "Too similar to a past direction", false],
    ]);
    expect(g2?.directions[0]?.firstViewport).toBe(
      ".vtc/design/prototype/calm-ledger/first-viewport.png",
    );
    expect(g2?.directions[1]?.firstViewport).toBeNull();
  });

  it("lists every unverified fact with why, and the waiver reason given for it", () => {
    const [g2] = gateRequests(GATE_EVENTS);
    expect(g2?.facts.map((f) => [f.id, f.status.label, f.reason, f.waiver])).toEqual([
      [
        "f-0123456789abcdef",
        "Unverified",
        "quote not found in the source",
        "MIT per the package page",
      ],
      [
        "f-fedcba9876543210",
        "Stale",
        "served stale after a failed revalidation",
        "EOL date checked by hand",
      ],
    ]);
    expect(g2?.facts[0]?.sourceUrl).toBe("https://registry.npmjs.org/react");
  });

  it("explains the design coverage check", () => {
    const [g2] = gateRequests(GATE_EVENTS);
    expect(g2?.coverage).toEqual({
      ok: false,
      problems: ["REQ-4 has no screen", "Component date-picker is not registered"],
    });
  });

  it("is pending until a decision on the same gate, and a newer request supersedes it", () => {
    expect(pendingGate([request])?.outcome.id).toBe("pending");
    expect(pendingGate(GATE_EVENTS)).toBeNull();
    const again = w3Event(70, "gate.requested", { gates: ["G2"], artifacts: frozen });
    const views = gateRequests([request, again]);
    expect(views.map((v) => v.outcome.id)).toEqual(["pending", "superseded"]);
    const g1 = w3Event(71, "gate.rejected", { gates: ["G1"], note: "spec unclear" });
    expect(pendingGate([request, g1])?.outcome.id).toBe("pending");
  });

  it("stops waiting once the run finished without a decision", () => {
    const finished = w3Event(72, "run.finished", { outcome: "aborted" });
    const [view] = gateRequests([request, finished]);
    expect(view?.outcome).toMatchObject({
      id: "unanswered",
      label: "Not decided before the run ended",
    });
    expect(view?.outcome.live).toBeUndefined();
    expect(pendingGate([request, finished])).toBeNull();
  });

  it("shows a rejection with its note", () => {
    const rejected = w3Event(72, "gate.rejected", { gates: ["G2"], note: "Try a third direction" });
    const [view] = gateRequests([request, rejected]);
    expect(view?.outcome).toMatchObject({ id: "rejected", tone: "danger" });
    expect(view?.note).toBe("Try a third direction");
  });

  it("falls back to the ids when an older engine sent no details", () => {
    const bare = w3Event(73, "gate.requested", {
      gates: ["G2"],
      artifacts: frozen,
      design_directions: ["calm-ledger"],
      unverified_facts: ["f-0123456789abcdef"],
    });
    const [view] = gateRequests([bare]);
    expect(view?.directions[0]).toMatchObject({ id: "calm-ledger", title: "calm-ledger" });
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
