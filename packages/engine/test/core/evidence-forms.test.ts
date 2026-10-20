/**
 * Evidence in the forms roles write (spine §5 reading 274), with synthetic data only: a spec ref
 * by path and anchor or by path and line, and a role's own pack cited by its relative path.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolves, type EvidenceContext } from "../../src/core/evidence.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";

afterEach(cleanupDirs);

const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("evidence forms", () => {
  it("resolves spec refs by path and a role's pack by a relative path, and nothing else with ..", async () => {
    const repoRoot = tempDir();
    writeFile(repoRoot, ".vtc/spec/spec.md", lines(40));
    writeFile(repoRoot, ".vtc/state/packs/a-14.md", lines(40));
    const ctx: EvidenceContext = {
      repoRoot,
      packRoot: repoRoot,
      head: null,
      specIds: ["REQ-23", "REQ-23.AC-1"],
      git: { readFileAtCommit: () => Promise.resolve(undefined) },
      commitExists: () => Promise.resolve(false),
    };
    expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md#REQ-23" })).toBe(true);
    expect(await resolves(ctx, { type: "spec_ref", ref: "REQ-23" })).toBe(true);
    expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md:39" })).toBe(true);
    expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md" })).toBe(true);
    expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md#REQ-99" })).toBe(false);
    expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md:41" })).toBe(false);
    expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/missing.md" })).toBe(false);
    expect(await resolves(ctx, { type: "file", ref: "../../packs/a-14.md" })).toBe(true);
    expect(await resolves(ctx, { type: "file_line", ref: "../../packs/a-14.md:39" })).toBe(true);
    expect(await resolves(ctx, { type: "file_line", ref: "../../packs/a-14.md:41" })).toBe(false);
    expect(await resolves(ctx, { type: "file", ref: "../../packs/../x.md" })).toBe(false);
    expect(await resolves(ctx, { type: "file", ref: "../../../etc/passwd" })).toBe(false);
  });
});
