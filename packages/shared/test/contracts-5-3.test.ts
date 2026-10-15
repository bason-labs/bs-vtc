/**
 * Contracts 5.3.0 (MINOR; spine §5 reading 216): an engine crash keeps its VTC stack frames, so a
 * VTC defect can be located; a fixable automatic issue carries `vtc:fixable`; the issue listing
 * carries each issue's title and body, so the bs-vtc checkout's engine can start a run from an
 * issue another project's daemon opened (D-bv (2), D-cd).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AUTO_LABELS,
  CONTRACTS_VERSION,
  validateEventData,
  type AutoIssueRef,
  type AutomationDeps,
} from "../src/index.js";

describe("contracts 5.3.0", () => {
  it("is MINOR over 5.2.0", () => {
    expect(CONTRACTS_VERSION).toBe("5.3.0");
  });

  it("lets an incident carry the VTC frames of its stack, and stays valid without them", () => {
    const frames = "    at spawn (packages/engine/src/core/engine.ts:10:5)";
    const withStack = validateEventData("incident.recorded", {
      kind: "crash",
      detail: "background job x failed: boom",
      stack: frames,
    });
    expect(withStack.ok).toBe(true);
    expect(validateEventData("incident.recorded", { kind: "crash", detail: "x" }).ok).toBe(true);
    expect(
      validateEventData("incident.recorded", {
        kind: "crash",
        detail: "x",
        stack: "a".repeat(4001),
      }).ok,
    ).toBe(false);
  });

  it("names the label of an issue VTC will try to fix itself", () => {
    expect(AUTO_LABELS.fixable).toBe("vtc:fixable");
  });

  it("lets the cli hand the daemon a scan of VTC's own dependencies", () => {
    expectTypeOf<AutomationDeps["vtcAdvisories"]>().toEqualTypeOf<
      | (() => Promise<readonly { readonly id: string; readonly package: string }[] | null>)
      | undefined
    >();
  });

  it("lets the issue listing carry each issue's title and body", () => {
    expectTypeOf<AutoIssueRef["title"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AutoIssueRef["body"]>().toEqualTypeOf<string | undefined>();
  });
});
