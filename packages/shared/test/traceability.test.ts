import { describe, expect, it } from "vitest";
import {
  agentNameFor,
  formatProvenance,
  formatReqTag,
  parseProvenance,
  parseReqTags,
  PROMPT_MARKERS,
  splitRolePrompt,
} from "../src/index.js";

describe("REQ tags in test names", () => {
  it("formats and parses tags, deduplicated in order", () => {
    expect(formatReqTag("REQ-3.AC-2")).toBe("[REQ-3.AC-2]");
    expect(parseReqTags("reset link expires [REQ-3.AC-2] [SEC-1][REQ-3.AC-2] [REQ-4]")).toEqual([
      "REQ-3.AC-2",
      "SEC-1",
      "REQ-4",
    ]);
  });
  it("ignores malformed tags and refuses to format them", () => {
    expect(parseReqTags("x [REQ-0] [AC-1] REQ-3 [req-3] [REQ-3.AC-0]")).toEqual([]);
    expect(() => formatReqTag("AC-1")).toThrow();
  });
});

describe("assertion provenance", () => {
  it.each([
    [{ kind: "spec", ref: "REQ-3.AC-2", quote: 'link expires after "15" minutes' }],
    [{ kind: "spec", ref: "SEC-1", quote: "tokens are single-use" }],
    [{ kind: "observed" }],
  ] as const)("round-trips %j", (provenance) => {
    expect(parseProvenance(formatProvenance(provenance))).toEqual(provenance);
  });
  it("uses the documented text form", () => {
    expect(formatProvenance({ kind: "spec", ref: "REQ-3", quote: "q" })).toBe('spec:REQ-3 "q"');
    expect(formatProvenance({ kind: "observed" })).toBe("observed");
  });
  it.each([
    "",
    "spec:REQ-3",
    'spec:AC-1 "q"',
    'spec:REQ-3 ""',
    "spec:REQ-3 'q'",
    "observed!",
    'spec:REQ-3 "q" x',
  ])("rejects %j", (text) => {
    expect(parseProvenance(text)).toBeNull();
  });
});

describe("agentNameFor", () => {
  it("names one agent per role, or per role mode", () => {
    expect(agentNameFor("ba")).toBe("vtc-ba");
    expect(agentNameFor("spec_verifier")).toBe("vtc-spec-verifier");
    expect(agentNameFor("qa", "author")).toBe("vtc-qa-author");
    expect(agentNameFor("security", "verify")).toBe("vtc-security-verify");
    expect(agentNameFor("engineer_frontend", "v1.2")).toBe("vtc-engineer-frontend-v1-2");
  });
  it("rejects ids that are not role ids or slugs", () => {
    expect(() => agentNameFor("QA")).toThrow();
    expect(() => agentNameFor("qa", "Author")).toThrow();
  });
});

describe("splitRolePrompt", () => {
  const prompt = (locked = "Mission: judge one AC.", editable = "Prefer short citations.") =>
    `${PROMPT_MARKERS.locked}\n${locked}\n\n${PROMPT_MARKERS.editable}\n${editable}\n`;
  it("splits the locked core from the editable section", () => {
    expect(splitRolePrompt(`\n${prompt()}`)).toEqual({
      ok: true,
      locked: "Mission: judge one AC.",
      editable: "Prefer short citations.",
    });
  });
  it.each([
    ["no markers", "Just a prompt."],
    ["missing editable", `${PROMPT_MARKERS.locked}\ncore\n`],
    ["repeated locked", `${prompt()}\n${PROMPT_MARKERS.locked}\n`],
    ["wrong order", `${PROMPT_MARKERS.editable}\nedit\n${PROMPT_MARKERS.locked}\ncore\n`],
    ["text before locked", `intro\n${prompt()}`],
    ["empty core", prompt("")],
    ["empty editable", prompt("core", "")],
    ["inline marker", `${PROMPT_MARKERS.locked} core\n${PROMPT_MARKERS.editable}\nedit`],
  ])("rejects a malformed prompt (%s)", (_case, text) => {
    const result = splitRolePrompt(text);
    expect(result.ok).toBe(false);
  });
});
