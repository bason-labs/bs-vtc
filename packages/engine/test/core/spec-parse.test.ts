import { describe, expect, it } from "vitest";
import { parseSpecItems, specRequirementIds } from "../../src/core/spec.js";

const SPEC = [
  "**REQ-1** (revised r2) When a scan runs for a source with an API, the system shall use it.",
  "- REQ-1.AC-1: Given an API, When the scan runs, Then 0 browser calls are made.",
  "**REQ-2** The system shall record each scan.",
  "**REQ-4** (revised r2) If a source has no API, then the system shall use the browser.",
  "- REQ-4.AC-1: Given no API, When the scan runs, Then the browser is used.",
  "**REQ-21** (added r2) The system shall try access paths in a fixed order.",
  "- REQ-7.AC-1: Given X, When Y, Then Z.",
  "## REQ-30 Heading form",
].join("\n");

describe("parseSpecItems (fault 9: the owner's revised spec)", () => {
  it("finds bold ids with an annotation, plain bold ids, headings and AC-implied REQs", () => {
    expect(specRequirementIds(parseSpecItems(SPEC))).toEqual([
      "REQ-1",
      "REQ-2",
      "REQ-4",
      "REQ-21",
      "REQ-7",
      "REQ-30",
    ]);
  });
  it("keeps the requirement's text without the annotation", () => {
    const req4 = parseSpecItems(SPEC).find((i) => i.id === "REQ-4");
    expect(req4?.text).toBe("If a source has no API, then the system shall use the browser.");
  });
  it("does not invent ids from prose mentions", () => {
    const ids = specRequirementIds(
      parseSpecItems("This run only reads (REQ-1 to REQ-7, REQ-21 to REQ-25).\n**REQ-1** Read."),
    );
    expect(ids).toEqual(["REQ-1"]);
  });
  it("keeps the older bold forms and prose headings", () => {
    const items = parseSpecItems(
      [
        "**REQ-1:** Colon inside the bold.",
        "**REQ-2.** Dot inside the bold.",
        "**REQ-3: A title**",
        "## REQ-4",
        "The system shall do four.",
      ].join("\n"),
    );
    expect(specRequirementIds(items)).toEqual(["REQ-1", "REQ-2", "REQ-3", "REQ-4"]);
    expect(items.map((i) => i.text)).toEqual([
      "Colon inside the bold.",
      "Dot inside the bold.",
      "A title",
      "The system shall do four.",
    ]);
  });
  it("lets an AC come before its requirement's own line, and ignores mid-sentence ids", () => {
    const items = parseSpecItems(
      "- REQ-5.AC-1: Given a, When b, Then c.\n**REQ-5** The system shall five.\nThe plan covers REQ-9: x.",
    );
    expect(items.map((i) => i.id)).toEqual(["REQ-5.AC-1", "REQ-5"]);
    expect(items[1]?.text).toBe("The system shall five.");
  });
  it("does not define a requirement its annotation removes or defers", () => {
    const items = parseSpecItems(
      [
        "**REQ-9** (removed r2) The system shall export to CSV.",
        "- **REQ-10** (deferred): The system shall send email.",
        "**REQ-11** (Out of scope in r2) The system shall print.",
        "- **REQ-12** (DROPPED) The system shall fax.",
        "**REQ-13** (deleted r3): The system shall beep.",
      ].join("\n"),
    );
    expect(specRequirementIds(items)).toEqual([]);
  });
  it("still defines a requirement its annotation revises or adds", () => {
    const items = parseSpecItems(
      [
        "**REQ-1** (revised r2) The system shall read.",
        "- **REQ-2** (added r2): The system shall write.",
      ].join("\n"),
    );
    expect(specRequirementIds(items)).toEqual(["REQ-1", "REQ-2"]);
  });
});
