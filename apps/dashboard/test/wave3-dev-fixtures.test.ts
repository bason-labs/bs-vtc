import { describe, expect, it } from "vitest";
import { devArtifact } from "../scripts/dev-fixtures.ts";
import { GOLDEN_RUN } from "../scripts/fixture-routes.ts";
import {
  ENGINEER_SCORECARD,
  FACT_ROWS,
  PNG_BASE64,
  ROUTING_SCORECARD,
  SCORECARD_INDEX,
  VISUAL_DIR,
  VISUAL_REPORT,
} from "./dev-samples";

/**
 * The dashboard's own dev fixtures (what the golden run does not record) hold to their contracts:
 * `dev-samples.ts` parses each, so a file that broke its contract would fail here first.
 */
describe("wave-3 dev fixtures", () => {
  it("parse against their contracts", () => {
    expect(VISUAL_REPORT.task).toBe("T-1");
    expect(SCORECARD_INDEX.scorecards.length).toBeGreaterThan(0);
    expect(ENGINEER_SCORECARD.prompt.role).toBe("engineer");
    expect(FACT_ROWS.length).toBeGreaterThan(0);
    expect(ROUTING_SCORECARD.cells.length).toBeGreaterThan(0);
  });

  it("serve a screenshot base64-encoded, like the engine", () => {
    const png = devArtifact(GOLDEN_RUN, `${VISUAL_DIR}/login-default-390-light.png`);
    expect(png).toMatchObject({ encoding: "base64", media_type: "image/png", content: PNG_BASE64 });
  });
});
