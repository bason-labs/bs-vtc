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
    expect(specRequirementIds(parseSpecItems(SPEC))).toEqual(
      ["REQ-1", "REQ-2", "REQ-4", "REQ-21", "REQ-7", "REQ-30"],
    );
  });
  it("keeps the requirement's text without the annotation", () => {
    const req4 = parseSpecItems(SPEC).find((i) => i.id === "REQ-4");
    expect(req4?.text).toBe("If a source has no API, then the system shall use the browser.");
  });
  it("does not invent ids from prose mentions", () => {
    const ids = specRequirementIds(parseSpecItems("This run only reads (REQ-1 to REQ-7, REQ-21 to REQ-25).\n**REQ-1** Read."));
    expect(ids).toEqual(["REQ-1"]);
  });
});
