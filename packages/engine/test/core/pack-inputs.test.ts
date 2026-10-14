/**
 * Pack inputs carry the artifact types the role contracts declare (AD-14 rule 5): the type the
 * producing role submitted, never a path guess like `design`; DISCOVER's outputs reach the later
 * phase roles that declare them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeadAction } from "@vtc/shared";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  only,
  SPEC_ONE,
  spawns,
  submitResult,
  threatModel,
  workdir,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

// Whole engine flows on a real repo spawn a few hundred git processes per test: under turbo's
// parallel load the 5 s default is too tight, so they get room on a loaded machine. A real hang
// still fails, and no assertion changes.
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanupDirs);

const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;

/** The `type: path` lines of a pack's Inputs section. */
const inputsOf = (h: Harness, action: SpawnAction): string[] =>
  (readFileSync(join(h.repo, action.pack), "utf8").split("## Inputs\n")[1] ?? "")
    .split("\n## ")[0]
    ?.trim()
    .split("\n")
    .map((l) => l.replace(/^- /, "")) ?? [];

const approveGate = async (h: Harness, actions: readonly LeadAction[]): Promise<LeadAction[]> => {
  const gate = actions.find((a) => a.type === "approve_gate");
  if (gate?.type !== "approve_gate")
    throw new Error(`expected a gate, got ${JSON.stringify(actions)}`);
  return (
    await h.engine.approve(
      { gates: gate.gates, decision: "approve", frozen: gate.artifacts, waived_facts: [] },
      CLAUDE,
    )
  ).actions;
};

describe("pack inputs by declared artifact type (AD-14 rule 5)", () => {
  it("types frozen design files as the Designer submitted them and passes DISCOVER's outputs on", async () => {
    const h = createHarness();
    await h.engine.start(
      { request: "Signup page", track: "feature", repo: "existing", has_ui: true, risk_hints: [] },
      CLAUDE,
    );
    const carto = only(await next(h), "repo_cartographer");
    writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
    const ba = only(
      (
        await submitResult(h, carto, {
          exit: "done",
          artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
        })
      ).actions,
      "ba",
    );
    expect(inputsOf(h, ba)).toContain("repo_map: .vtc/research/repo-map/map.md");
    writeFile(workdir(ba), ".vtc/spec/spec.md", SPEC_ONE);
    const g1 = await submitResult(h, ba, {
      exit: "done",
      artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
    });
    const design = await approveGate(h, g1.actions);
    const [architect, security] = spawns(design);
    expect(architect?.role).toBe("architect");
    expect(security).toMatchObject({ role: "security", mode: "design" });
    // two at a time (the default concurrency): the Designer once Security is done
    const designer = only(await threatModel(h, security!), "designer");
    for (const role of [architect!, designer]) {
      expect(inputsOf(h, role)).toContain("repo_map: .vtc/research/repo-map/map.md");
      expect(inputsOf(h, role)).toContain("spec: .vtc/spec/spec.md");
    }
    writeFile(workdir(architect!), ".vtc/architecture/spine.md", "# spine\n");
    writeFile(workdir(designer), ".vtc/design/flows.mmd", "flowchart LR\n");
    writeFile(workdir(designer), ".vtc/design/screens.yaml", "screens: []\n");
    await submitResult(h, architect!, {
      exit: "done",
      artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
    });
    const g2 = await submitResult(h, designer, {
      exit: "done",
      artifacts: [
        { type: "design_flows", path: ".vtc/design/flows.mmd" },
        { type: "screens", path: ".vtc/design/screens.yaml" },
      ],
    });
    const planner = only(await approveGate(h, g2.actions), "planner");
    const inputs = inputsOf(h, planner);
    expect(inputs).toEqual(
      expect.arrayContaining([
        "repo_map: .vtc/research/repo-map/map.md",
        "spec: .vtc/spec/spec.md",
        "architecture: .vtc/architecture/spine.md",
        "design_flows: .vtc/design/flows.mmd",
        "screens: .vtc/design/screens.yaml",
      ]),
    );
    expect(inputs.filter((l) => l.startsWith("design:"))).toEqual([]);
    await h.release();
  });
});
