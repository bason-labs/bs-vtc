/**
 * The owner's quick fix in DESIGN (VTC 0.2.2, a Codex Lead; spine §5 readings 269 and 270), with
 * synthetic data only:
 * - a quick fix's spec is frozen only at its combined G1+G2 screen (§6.2), and DESIGN packs listed
 *   only frozen artifacts, so the Architect and Security's threat model got no spec and parked;
 * - every role cited its own pack (by the absolute path its dispatch names) and the claim check,
 *   which reads the role's worktree, rejected the result.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  only,
  submitResult,
  workdir,
  type Harness,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const SPEC = "# Spec\n\n## REQ-1 Order total\n\n- REQ-1.AC-1: the total shows on checkout\n";

const toDesign = async (h: Harness) => {
  await h.engine.start(
    {
      request: "Show the order total on checkout",
      track: "quick_fix",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );
  const ba = only((await h.engine.next({}, CLAUDE)).actions, "ba");
  writeFile(workdir(ba), ".vtc/spec/order-total.md", SPEC);
  const out = await submitResult(h, ba, {
    exit: "done",
    artifacts: [{ type: "spec", path: ".vtc/spec/order-total.md" }],
  });
  expect(out.accepted).toBe(true);
  expect(h.engine.status({}).run.phase).toBe("design");
  return only(out.actions, "architect");
};

describe("a quick fix's DESIGN roles (readings 269, 270)", { timeout: 30_000 }, () => {
  it("get the BA's spec in their pack before the combined G1+G2 screen freezes it", async () => {
    const h = createHarness();
    const architect = await toDesign(h);
    const pack = readFileSync(join(h.repo, architect.pack), "utf8");
    expect(pack).toContain("- spec: .vtc/spec/order-total.md");
    expect(readFileSync(join(workdir(architect), ".vtc/spec/order-total.md"), "utf8")).toBe(SPEC);
    await h.release();
  });

  it("may cite their own pack, by its absolute or its relative path", async () => {
    const h = createHarness();
    const architect = await toDesign(h);
    writeFile(workdir(architect), ".vtc/architecture/spine.md", "# Spine\n\nREQ-1: checkout\n");
    const out = await submitResult(h, architect, {
      exit: "done",
      artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
      claims: [
        { type: "file", ref: join(h.repo, architect.pack) },
        { type: "file_line", ref: `${architect.pack}:1` },
      ],
    });
    expect(out.accepted).toBe(true);
    await h.release();
  });

  it("still may not cite a file outside the packs by an absolute path", async () => {
    const h = createHarness();
    const architect = await toDesign(h);
    writeFile(workdir(architect), ".vtc/architecture/spine.md", "# Spine\n");
    const out = await submitResult(h, architect, {
      exit: "done",
      artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
      claims: [{ type: "file", ref: join(h.repo, ".vtc/spec/order-total.md") }],
    });
    expect(out.accepted).toBe(false);
    await h.release();
  });
});
