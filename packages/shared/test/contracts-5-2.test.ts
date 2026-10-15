/**
 * Contracts 5.2.0 (MINOR; spine §5 reading 215): the round-4 fix round. A Lookback PR on a stale
 * baseline skips with `stale_baseline`; an upstream report never carries an ARN or an account id
 * as its model; `AutomationDeps.ghLogin` probes the gh login (D-bz).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AutomationSkipReasonSchema,
  CONTRACTS_VERSION,
  UpstreamReportSchema,
  type AutomationDeps,
} from "../src/index.js";

const report = (model: string) => ({
  v: 1,
  kind: "defect",
  fingerprint: "0123456789abcdef",
  vtc_version: "0.5.0",
  model,
  occurrences: 1,
  first_seen: "2026-10-15T08:00:00.000Z",
  last_seen: "2026-10-15T08:00:00.000Z",
});

describe("contracts 5.2.0", () => {
  it("is MINOR over 5.1.0", () => {
    expect(CONTRACTS_VERSION).toBe("5.2.0");
  });

  it("names the stale-baseline skip of a Lookback PR", () => {
    expect(AutomationSkipReasonSchema.parse("stale_baseline")).toBe("stale_baseline");
  });

  it("refuses an ARN or an account id as an upstream report's model (D-by, D-ci)", () => {
    for (const ok of [
      "gpt-5.5-codex",
      "opus",
      "custom",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "claude-sonnet-4-5@20250929",
    ])
      expect(UpstreamReportSchema.safeParse(report(ok)).success, ok).toBe(true);
    for (const bad of [
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc",
      "ARN:aws:bedrock:eu-west-1:x",
      "profile-123456789012",
    ])
      expect(UpstreamReportSchema.safeParse(report(bad)).success, bad).toBe(false);
  });

  it("lets the cli hand the daemon a gh-login probe", () => {
    expectTypeOf<AutomationDeps["ghLogin"]>().toEqualTypeOf<(() => Promise<boolean>) | undefined>();
  });
});
