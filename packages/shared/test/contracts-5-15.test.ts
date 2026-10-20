/**
 * Contracts 5.15.0 (MINOR; spine §5 reading 276): a format rejection is fixed in the same
 * session. `role.rejected` carries the host session the rejected run used, which the re-dispatch
 * resumes; a run that named none leaves it out.
 */
import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, EVENT_PAYLOAD_SCHEMAS } from "../src/index.js";

describe("contracts 5.15.0", () => {
  it("is 5.15.0, MINOR over 5.14.0", () => {
    expect(CONTRACTS_VERSION).toBe("5.15.0");
  });

  it("role.rejected names the rejected run's session, or none", () => {
    const rejected = EVENT_PAYLOAD_SCHEMAS["role.rejected"];
    const base = { action_id: "a-1", reason: "claim_check", issues: ["does not resolve"] };
    const session_ref = { host: "claude-code", id: "s-1" };
    expect(rejected.parse({ ...base, session_ref }).session_ref).toEqual(session_ref);
    expect(rejected.parse(base).session_ref).toBeUndefined();
    expect(rejected.safeParse({ ...base, session_ref: null }).success).toBe(false);
    expect(rejected.safeParse({ ...base, session_ref: { host: "claude-code" } }).success).toBe(
      false,
    );
  });
});
