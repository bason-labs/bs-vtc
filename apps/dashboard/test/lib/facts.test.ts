import { describe, expect, it } from "vitest";
import { FactRowSchema, FactStatusSchema } from "@vtc/shared";
import { currentFacts, factCounts, factStatusMeta, parseFactsJsonl } from "@/lib/facts";
import { FACT_EVENTS, FACTS_JSONL, GATE_EVENTS, w3Event } from "../wave3-fixtures";

describe("parseFactsJsonl (.vtc/research/facts.jsonl)", () => {
  it("reads every FactRow line", () => {
    const file = parseFactsJsonl(FACTS_JSONL);
    expect(file.rows.map((r) => r.id)).toEqual([
      "f-0123456789abcdef",
      "f-1111111111111111",
      "f-fedcba9876543210",
      "f-2222222222222222",
    ]);
    expect(file.invalid).toEqual([]);
  });

  it("skips blank lines and reports lines that break the contract by number", () => {
    const file = parseFactsJsonl(`${FACTS_JSONL}\nnot json\n{"v":1,"id":"x"}\n`);
    expect(file.rows).toHaveLength(4);
    expect(file.invalid).toEqual([6, 7]);
  });
});

describe("currentFacts", () => {
  const rows = parseFactsJsonl(FACTS_JSONL).rows;

  it("hides superseded rows and counts what each current row replaced", () => {
    const facts = currentFacts(rows);
    expect(facts.map((f) => f.id)).not.toContain("f-0123456789abcdef");
    expect(facts.find((f) => f.id === "f-1111111111111111")?.replaced).toBe(1);
  });

  it("lists what needs attention first: unverified, conflicting, stale, then waived, verified", () => {
    expect(currentFacts(rows).map((f) => f.status.label)).toEqual([
      "Unverified",
      "Stale",
      "Verified",
    ]);
  });

  it("shows the source, its locator and a web link only for http(s) URLs", () => {
    const stale = currentFacts(rows).find((f) => f.id === "f-fedcba9876543210")!;
    expect(stale.value).toBe("2027-04-30");
    expect(stale.source).toMatchObject({
      fetcher: "eol",
      url: "https://endoflife.date/api/nodejs/22.json",
      locator: "JSON pointer /eol",
    });
    expect(stale.expiresAt).toBe("2026-09-08T09:00:00.000Z");
    const model = currentFacts(rows).find((f) => f.id === "f-2222222222222222")!;
    expect(model.source).toBeNull();
    expect(model.recordedBy).toBe("architect");
  });

  it("shows where the role reported an unverified claim from (H-3): host search and its query", () => {
    const model = currentFacts(rows).find((f) => f.id === "f-2222222222222222")!;
    expect(model.reportedSource).toEqual({
      via: "Reported via host search for “vendor-sdk latest version”",
      url: "https://vendor.example.com/sdk/releases",
      href: "https://vendor.example.com/sdk/releases",
    });
    const fetched = FactRowSchema.parse({
      ...rows.find((r) => r.id === "f-2222222222222222")!,
      reported_source: { url: "ftp://vendor.example.com/notes", via: "host_fetch" },
    });
    expect(currentFacts([fetched])[0]?.reportedSource).toEqual({
      via: "Reported via host fetch",
      url: "ftp://vendor.example.com/notes",
      href: null,
    });
  });

  it("shows a reported source only next to a fact that is not verified", () => {
    const row = rows.find((r) => r.id === "f-1111111111111111")!;
    const verified = FactRowSchema.parse({
      ...row,
      reported_source: { url: "https://registry.npmjs.org/react", via: "host_fetch" },
    });
    expect(currentFacts([verified])[0]?.reportedSource).toBeNull();
    expect(
      currentFacts(rows).find((f) => f.id === "f-fedcba9876543210")?.reportedSource,
    ).toBeNull();
  });

  it("applies a later fact.waived event with its reason", () => {
    const facts = currentFacts(rows, GATE_EVENTS);
    const waived = facts.find((f) => f.id === "f-fedcba9876543210")!;
    expect(waived.status.label).toBe("Waived");
    expect(waived.waiver).toBe("EOL date checked by hand");
  });

  it("applies a later fact.verified event, but not one older than the row", () => {
    const later = currentFacts(rows, [
      w3Event(90, "fact.verified", { id: "f-2222222222222222", status: "conflicting" }),
    ]);
    expect(later.find((f) => f.id === "f-2222222222222222")?.status.label).toBe("Conflicting");
    const older = currentFacts(rows, [
      {
        ...FACT_EVENTS[0]!,
        ts: "2026-01-01T00:00:00.000Z",
        data: { id: "f-2222222222222222", status: "verified" },
      },
    ]);
    expect(older.find((f) => f.id === "f-2222222222222222")?.status.label).toBe("Unverified");
  });

  const stale = rows.find((r) => r.id === "f-fedcba9876543210")!;
  const reverified = FactRowSchema.parse({
    ...stale,
    status: "verified",
    expires_at: "2026-10-20T09:00:00.000Z",
    recorded_at: "2026-10-12T11:00:00.000Z",
  });

  it("shows only the newest row of an id (a new status is a new row with the same id)", () => {
    const facts = currentFacts([...rows, reverified]);
    const same = facts.filter((f) => f.id === stale.id);
    expect(same.map((f) => f.status.label)).toEqual(["Verified"]);
    expect(new Set(facts.map((f) => f.id)).size).toBe(facts.length);
  });

  it("shows a claim recorded again after a later row superseded it", () => {
    const original = rows.find((r) => r.id === "f-0123456789abcdef")!;
    const again = FactRowSchema.parse({ ...original, recorded_at: "2026-10-12T12:00:00.000Z" });
    const facts = currentFacts([...rows, again]);
    expect(facts.filter((f) => f.id === original.id).map((f) => f.status.label)).toEqual([
      "Unverified",
    ]);
    // Superseded again after it was recorded again: hidden.
    const replacement = rows.find((r) => r.id === "f-1111111111111111")!;
    const later = FactRowSchema.parse({
      ...replacement,
      recorded_at: "2026-10-12T13:00:00.000Z",
    });
    expect(currentFacts([...rows, again, later]).map((f) => f.id)).not.toContain(original.id);
  });

  it("ignores a row that names its own id in supersedes", () => {
    const self = FactRowSchema.parse({ ...reverified, supersedes: reverified.id });
    const fact = currentFacts([...rows, self]).find((f) => f.id === self.id);
    expect(fact?.status.label).toBe("Verified");
    expect(fact?.replaced).toBe(0);
  });

  it("counts and waives a re-recorded fact once", () => {
    const facts = currentFacts(
      [...rows, reverified],
      [w3Event(95, "fact.waived", { id: stale.id, reason: "Checked by hand" })],
    );
    expect(factCounts(facts).reduce((n, c) => n + c.n, 0)).toBe(3);
    expect(facts.filter((f) => f.waiver === "Checked by hand")).toHaveLength(1);
  });

  it("names every status", () => {
    for (const s of FactStatusSchema.options) expect(factStatusMeta(s).label).not.toBe("");
    expect(factStatusMeta("verified").tone).toBe("ok");
    expect(factStatusMeta("unverified").tone).toBe("danger");
  });
});
