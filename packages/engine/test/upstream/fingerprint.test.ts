/** Fingerprint stability (AD-27 rule 3; spine §5 reading 208): stable fields only. */
import { AutoFingerprintSchema, VtcFrameSchema } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import { autoFingerprint, vtcFramesFromStack } from "../../src/upstream/index.js";

const STACK_A = `TypeError: Cannot read properties of undefined (reading 'x')
    at parseLine (/Users/alice/work/bs-vtc/packages/adapters/src/codex/parse.ts:120:17)
    at Array.map (<anonymous>)
    at async runTurn (/Users/alice/work/bs-vtc/packages/engine/src/core/loop.ts:88:5)
    at handler (/Users/alice/clients/acme/app/src/server.ts:10:2)
    at Object.<anonymous> (/Users/alice/work/bs-vtc/packages/engine/dist/core/kernel.js:5:1)
    at next (/Users/alice/work/bs-vtc/packages/engine/src/core/scheduler.ts:1:1)`;

const ROOTS_A = ["/Users/alice/work/bs-vtc"];
const ROOTS_B = ["/opt/vtc", "/home/bob/vtc"];

const STACK_B = `TypeError: Cannot read properties of undefined (reading 'y')
    at parseLine (/opt/vtc/node_modules/@vtc/adapters/dist/codex/parse.js:999:3)
    at async runTurn (/home/bob/vtc/packages/engine/src/core/loop.ts:12:9)
    at Object.<anonymous> (/home/bob/vtc/packages/engine/src/core/kernel.ts:77:1)`;

describe("VTC stack frames", () => {
  it("keep package/file:function and drop lines, absolute paths and project frames", () => {
    const frames = vtcFramesFromStack(STACK_A, ROOTS_A);
    expect(frames).toEqual([
      "adapters/codex/parse:parseLine",
      "engine/core/loop:runTurn",
      "engine/core/kernel:Object.<anonymous>",
    ]);
    for (const frame of frames) expect(VtcFrameSchema.safeParse(frame).success).toBe(true);
    expect(frames.join(" ")).not.toMatch(/alice|acme|\d+:\d+/);
  });
  it("are the same across machines, checkouts, builds and versions", () => {
    expect(vtcFramesFromStack(STACK_B, ROOTS_B)).toEqual(vtcFramesFromStack(STACK_A, ROOTS_A));
  });
  it("fail closed: without VTC's roots no absolute frame counts, nor a project monorepo's", () => {
    expect(vtcFramesFromStack(STACK_A)).toEqual([]);
    const project = `Error: x
    at handler (/Users/alice/clients/acme/packages/engine/src/server.ts:10:2)`;
    expect(vtcFramesFromStack(project, ROOTS_A)).toEqual([]);
  });
  it("read the single-file binary's frames: sourcemapped paths, else named bundle frames", () => {
    // What \`bun build --compile --sourcemap\` prints, and the same binary without a sourcemap.
    const mapped = `Error: boom
    at parseLine (packages/adapters/src/codex/parse.ts:1:58)
    at packages/cli/src/main.ts:3:7
    at handler (/Users/alice/clients/acme/app/src/server.ts:10:2)`;
    expect(vtcFramesFromStack(mapped)).toEqual([
      "adapters/codex/parse:parseLine",
      "cli/main:<anonymous>",
    ]);
    expect(vtcFramesFromStack(mapped)[0]).toBe(vtcFramesFromStack(STACK_A, ROOTS_A)[0]);
    const bundled = `Error: boom
    at parseLine (/$bunfs/root/vtc:4:18)
    at /$bunfs/root/vtc:12:10`;
    expect(vtcFramesFromStack(bundled)).toEqual(["cli/bundle:parseLine"]);
  });
});

describe("autoFingerprint", () => {
  it("is 16 hex and stable for the same stable fields", () => {
    const a = autoFingerprint({
      kind: "defect",
      errorClass: "adapter.parse_failure",
      host: "codex",
      role: "implementer",
      frames: vtcFramesFromStack(STACK_A, ROOTS_A),
    });
    const b = autoFingerprint({
      kind: "defect",
      errorClass: "adapter.parse_failure",
      host: "codex",
      role: "implementer",
      frames: vtcFramesFromStack(STACK_B, ROOTS_B),
    });
    expect(AutoFingerprintSchema.safeParse(a).success).toBe(true);
    expect(a).toBe(b);
    expect(
      autoFingerprint({ kind: "defect", errorClass: "adapter.parse_failure", frames: [] }),
    ).not.toBe(a);
  });
  it("ignores the version of a security advisory's package", () => {
    const one = autoFingerprint({
      kind: "security",
      advisoryId: "GHSA-aaaa-bbbb-cccc",
      package: "yaml",
    });
    const two = autoFingerprint({
      kind: "security",
      advisoryId: "ghsa-aaaa-bbbb-cccc",
      package: "YAML",
    });
    expect(one).toBe(two);
  });
  it("keys Lookback by role and proposal kind, not the proposal, so a newer one supersedes", () => {
    const a = autoFingerprint({ kind: "lookback", subject: "implementer", proposalKind: "prompt" });
    expect(a).toBe(
      autoFingerprint({ kind: "lookback", subject: "implementer", proposalKind: "prompt" }),
    );
    expect(a).not.toBe(
      autoFingerprint({ kind: "lookback", subject: "reviewer", proposalKind: "prompt" }),
    );
  });
  it("differs by kind and target class for the same fields", () => {
    const cost = autoFingerprint({
      kind: "cost",
      role: "implementer",
      metric: "tokens_per_success",
      baselinePromptSha: "a".repeat(64),
    });
    expect(cost).toMatch(/^[a-f0-9]{16}$/);
    const parked = autoFingerprint({
      kind: "parked",
      ruleId: "stuck",
      path: "./src//a.ts",
      taskKind: "feature",
    });
    expect(parked).toBe(
      autoFingerprint({ kind: "parked", ruleId: "stuck", path: "src/a.ts", taskKind: "feature" }),
    );
    expect(parked).not.toBe(
      autoFingerprint({ kind: "finding", ruleId: "stuck", path: "src/a.ts", taskKind: "feature" }),
    );
  });
  it("refuses absolute paths and line numbers in project fingerprints", () => {
    expect(() =>
      autoFingerprint({ kind: "finding", ruleId: "r", path: "/Users/alice/app/src/a.ts" }),
    ).toThrow(/relative/);
    expect(() => autoFingerprint({ kind: "finding", ruleId: "r", path: "src/a.ts:12" })).toThrow(
      /line/,
    );
  });
});
