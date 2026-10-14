import { describe, expect, it } from "vitest";
import { devArtifact } from "../scripts/dev-fixtures.ts";
import { GOLDEN_RUN } from "../scripts/fixture-routes.ts";
import {
  ENGINEER_SCORECARD,
  FACT_ROWS,
  PNG_BASE64,
  SCORECARD_INDEX,
  VISUAL_DIR,
  VISUAL_REPORT,
  VISUAL_REPORT_PATH,
} from "./wave3-fixtures";

const json = (path: string): unknown =>
  JSON.parse(devArtifact(GOLDEN_RUN, path)?.content ?? "null");

/** The dev fixture server's wave-3 files are the same samples the tests check against contracts. */
describe("wave-3 dev fixtures", () => {
  it("match the contract-checked samples", () => {
    expect(json(VISUAL_REPORT_PATH)).toEqual(VISUAL_REPORT);
    expect(json(".vtc/lookback/scorecards/index.json")).toEqual(SCORECARD_INDEX);
    expect(json(SCORECARD_INDEX.scorecards[0]!.path)).toEqual(ENGINEER_SCORECARD);
    const facts = devArtifact(GOLDEN_RUN, ".vtc/research/facts.jsonl")?.content ?? "";
    expect(
      facts
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual(FACT_ROWS);
  });

  it("serve a screenshot base64-encoded, like the engine", () => {
    const png = devArtifact(GOLDEN_RUN, `${VISUAL_DIR}/login-default-390-light.png`);
    expect(png).toMatchObject({ encoding: "base64", media_type: "image/png", content: PNG_BASE64 });
  });
});
