import { describe, expect, it } from "vitest";
import { HOST_IDS } from "@vtc/shared";
import { HOST_CAPABILITIES } from "../src/index.js";

describe("@vtc/adapters smoke", () => {
  it("declares capabilities for every host", () => {
    expect(Object.keys(HOST_CAPABILITIES).sort()).toEqual([...HOST_IDS].sort());
  });
  it("records the Codex gaps the engine must compensate for (§12.1)", () => {
    expect(HOST_CAPABILITIES.codex.perPathWriteDeny).toBe(false);
    expect(HOST_CAPABILITIES.codex.turnCap).toBe(false);
    expect(HOST_CAPABILITIES["claude-code"].perPathWriteDeny).toBe(true);
  });
});
