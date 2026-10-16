/**
 * Round 6 in the repo's own sources (contracts 5.7.0; spine §5 readings 237, 241, 242, 247(7)):
 * - H-13: the Architect and the Designer know what a coverage-loop dispatch asks
 *   (`TaskPack.coverage_gaps`, printed as Dispatch lines), and the Architect names the
 *   requirements each AD covers, since an AD that names a REQ now counts as coverage;
 * - D-ct, D-ce: the Designer writes `.vtc/design/flows.yaml` (`DesignFlowsFileSchema`);
 * - D-cu, D-cv: the Planner's start-tier text says the table starts the producers only, and how a
 *   start tier escalates, rendered from the shared rules.
 */
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  DESIGN_COVERAGE_ESCALATION_OPTIONS,
  DESIGN_COVERAGE_LOOP,
  DESIGN_FLOWS_PATH,
  DESIGN_SCREENS_PATH,
  DesignCoverageGapsSchema,
  DesignFlowsFileSchema,
  escalationSteps,
  FLOW_LIMITS,
  FlowStepSchema,
  renderTaskPack,
  reviewerStartTier,
  routedByDifficulty,
  TIER_ORDER,
  type HostId,
} from "@vtc/shared";
import {
  compilePlugins,
  COVERAGE_DISPATCH_LINES,
  loadRoles,
  PROTOCOL_VARS,
  readSources,
  renderStartRoles,
  renderTierEscalation,
  TASK_RUNS,
  type CompileOutput,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = readSources(ROOT);
const compiled = compilePlugins(read.files);
const loaded = loadRoles(read.files);

const output = (): CompileOutput => {
  if (!compiled.ok) {
    throw new Error(compiled.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  }
  return compiled.output;
};
const source = (path: string): string => read.files.find((f) => f.path === path)?.text ?? "";
const emitted = (host: HostId, path: string): string =>
  output().targets[host].find((f) => f.path === path)?.text ?? "";
const oneLine = (text: string): string => text.replace(/\s+/g, " ");
const agentBody = (host: HostId, agent: string): string =>
  host === "claude-code"
    ? emitted(host, `agents/${agent}.md`).replace(/^---\n[\s\S]*?\n---\n\n/, "")
    : emitted(host, `agents/${agent}.toml`);
const role = (id: string) => loaded.roles.find((r) => r.role.id === id)?.role;
const HOSTS: readonly HostId[] = ["claude-code", "codex"];
const code = (text: string): string => `\`${text}\``;
const section = (body: string, heading: string): string =>
  body.split(`## ${heading}`)[1]?.split(/\n## /)[0] ?? "";

const GAPS = DesignCoverageGapsSchema.parse({
  round: 2,
  reqs_without_component: ["REQ-3", "SEC-1"],
  reqs_without_screen: ["REQ-4"],
  screens_without_req: ["settings"],
  components_unregistered: ["date-picker"],
  screens_problem: "screens.0.route must start with /",
});

describe("the coverage-loop Dispatch lines (H-13, reading 237)", () => {
  const dispatch = (): string[] =>
    (
      renderTaskPack({
        v: 1,
        run: "r-1",
        action_id: "a-1",
        role: "designer",
        coverage_gaps: GAPS,
      }).split("## Intent contract")[0] ?? ""
    ).split("\n");

  it("names every line renderTaskPack prints for TaskPack.coverage_gaps", () => {
    const lines = dispatch();
    expect(lines).toContain(
      `- ${COVERAGE_DISPATCH_LINES.round}: 2 of ${String(DESIGN_COVERAGE_LOOP.maxRounds)}`,
    );
    expect(lines).toContain(`- ${COVERAGE_DISPATCH_LINES.reqs_without_component}: REQ-3, SEC-1`);
    expect(lines).toContain(`- ${COVERAGE_DISPATCH_LINES.reqs_without_screen}: REQ-4`);
    expect(lines).toContain(`- ${COVERAGE_DISPATCH_LINES.screens_without_req}: settings`);
    expect(lines).toContain(`- ${COVERAGE_DISPATCH_LINES.components_unregistered}: date-picker`);
    expect(lines).toContain(
      `- ${COVERAGE_DISPATCH_LINES.screens_problem}: screens.0.route must start with /`,
    );
  });

  it("has one label per DesignCoverageGaps field", () => {
    expect(Object.keys(COVERAGE_DISPATCH_LINES).sort()).toEqual(
      Object.keys(DesignCoverageGapsSchema.shape).sort(),
    );
  });

  it("fills the coverage placeholders from @vtc/shared", () => {
    expect(PROTOCOL_VARS.coverage_max_rounds).toBe(String(DESIGN_COVERAGE_LOOP.maxRounds));
    expect(PROTOCOL_VARS.coverage_round_line).toBe(COVERAGE_DISPATCH_LINES.round);
    expect(DESIGN_COVERAGE_ESCALATION_OPTIONS).toContain(PROTOCOL_VARS.instruct_architect_option);
  });
});

describe("the Architect's coverage fix (H-13, reading 237)", () => {
  it.each(HOSTS)("tells the %s agent what a coverage-loop dispatch asks", (host) => {
    const body = oneLine(agentBody(host, "vtc-architect"));
    expect(body).toContain(
      `\`${COVERAGE_DISPATCH_LINES.round}: <n> of ${String(DESIGN_COVERAGE_LOOP.maxRounds)}\``,
    );
    expect(body).toContain(code(COVERAGE_DISPATCH_LINES.reqs_without_component));
    expect(body).toMatch(/name each listed requirement in the `Covers` of an AD/);
    expect(body).toMatch(/or in the requirement-to-component map/);
    expect(body).toMatch(/pack's Requirements section/);
    expect(body).toMatch(/Never drop a requirement/);
    expect(body).toMatch(/never edit the specification/i);
    // the Designer's lines are not the Architect's to fix
    expect(body).toContain(code(COVERAGE_DISPATCH_LINES.reqs_without_screen));
    expect(body).toMatch(/are for the design, not for you/);
    // the human's instruction after a parked loop
    expect(body).toContain(code(`${PROTOCOL_VARS.instruct_architect_option ?? ""}: <text>`));
  });

  it.each(HOSTS)(
    "has the %s agent return its whole result again on a coverage round (reading 249)",
    (host) => {
      const body = oneLine(agentBody(host, "vtc-architect"));
      // the engine's DESIGN check and G2 read the latest result only
      expect(body).toMatch(
        /return every artifact of your previous result again, with the same types and paths, not only the files you changed/,
      );
      expect(body).toMatch(/the engine checks your latest result only/);
      expect(body).toMatch(/the architecture document with its requirement-to-component map/);
    },
  );

  it.each(HOSTS)("has the %s agent state the requirements each AD covers", (host) => {
    const body = oneLine(agentBody(host, "vtc-architect"));
    expect(body).toMatch(/\*\*Covers\*\* \(the REQ-n and SEC-n ids it serves/);
    expect(body).toMatch(/a requirement an AD names counts as covered/);
    const done = section(oneLine(agentBody(host, "vtc-architect")), "Definition of done");
    expect(done).toMatch(/every AD-n names the requirements it covers/);
  });

  it("shows Covers in the skill's AD template and example", () => {
    expect(oneLine(source("skills/architect/SKILL.md"))).toMatch(/Covers \(the REQ-n and SEC-n/);
    expect(source("skills/architect/references/adr.md")).toMatch(/^- Covers: /m);
    expect(source("skills/architect/references/fitness-functions.md")).toMatch(
      /^- \*\*Covers:\*\* REQ-/m,
    );
  });
});

describe("the Designer's coverage fix (H-13, reading 237)", () => {
  it.each(HOSTS)("tells the %s agent how to close each of its gaps", (host) => {
    const body = oneLine(agentBody(host, "vtc-designer"));
    expect(body).toContain(
      `\`${COVERAGE_DISPATCH_LINES.round}: <n> of ${String(DESIGN_COVERAGE_LOOP.maxRounds)}\``,
    );
    for (const key of [
      "reqs_without_screen",
      "screens_without_req",
      "components_unregistered",
      "screens_problem",
    ] as const) {
      expect(body, key).toContain(code(COVERAGE_DISPATCH_LINES[key]));
    }
    expect(body).toMatch(/put each listed requirement in the `reqs` of the screen that shows it/);
    expect(body).toMatch(/give each listed screen the requirements it covers/);
    expect(body).toMatch(/write a component spec for each listed component/);
    expect(body).toContain(`fix \`${DESIGN_SCREENS_PATH}\``);
    expect(body).toMatch(/pack's Requirements section/);
    expect(body).toMatch(/Never drop a requirement/);
    expect(body).toMatch(/Never drop a requirement or edit the specification/);
    expect(body).toContain(`${code(COVERAGE_DISPATCH_LINES.reqs_without_component)} is not yours`);
  });

  it.each(HOSTS)(
    "has the %s agent return its whole result again on a coverage round (reading 249)",
    (host) => {
      const body = oneLine(agentBody(host, "vtc-designer"));
      expect(body).toMatch(
        /return every artifact of your previous result again, with the same types and paths, not only the files you changed/,
      );
      expect(body).toMatch(/the engine checks your latest result only/);
      expect(body).toMatch(/every `design_direction` and `prototype` artifact/);
    },
  );
});

describe("the Designer's flows file (D-ct, D-ce, reading 247(7))", () => {
  const actions = FlowStepSchema.options.map((o) => o.shape.action.value);

  it.each(HOSTS)("has the %s agent write flows.yaml beside screens.yaml", (host) => {
    const body = oneLine(agentBody(host, "vtc-designer"));
    expect(body).toContain(`\`${DESIGN_FLOWS_PATH}\``);
    expect(body).toMatch(/one flow per key user journey/);
    for (const field of ["id", "start", "screens", "paths", "steps", "fixtures"]) {
      expect(body, field).toContain(code(field));
    }
    for (const action of actions) expect(body, action).toContain(code(action));
    expect(body).toContain(`1 to ${String(FLOW_LIMITS.maxSteps)} \`steps\``);
    expect(body).toMatch(/never inline text/);
    expect(body).toMatch(/never a password, token, key or real personal data/);
    expect(body).toMatch(/No step runs a script/);
    expect(body).toMatch(/`design_flows` \(the Mermaid flows and the flows file\)/);
  });

  it("fills the flow placeholders from @vtc/shared", () => {
    expect(PROTOCOL_VARS.design_flows_path).toBe(DESIGN_FLOWS_PATH);
    expect(PROTOCOL_VARS.flow_step_actions).toBe(
      FlowStepSchema.options
        .map((o) => {
          const fields = Object.keys(o.shape).filter((k) => k !== "action");
          return `${code(o.shape.action.value)} (${fields.map(code).join(", ")})`;
        })
        .join(", "),
    );
    expect(PROTOCOL_VARS.flow_step_actions).toContain("`fill` (`selector`, `fixture`)");
    expect(PROTOCOL_VARS.flow_max_steps).toBe(String(FLOW_LIMITS.maxSteps));
    expect(PROTOCOL_VARS.flow_max_wait_ms).toBe(String(FLOW_LIMITS.maxWaitMs));
  });

  it("gives an example flows file the shared schema accepts", () => {
    const body = agentBody("claude-code", "vtc-designer");
    const example = /```yaml\n([\s\S]*?)```/.exec(section(body, "Example"))?.[1];
    expect(example).toBeDefined();
    const parsed = DesignFlowsFileSchema.safeParse(parseYaml(example ?? ""));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const steps = parsed.data?.flows.flatMap((f) => f.steps.map((s) => s.action)) ?? [];
    expect(steps).toContain("fill");
  });

  it("keeps the flows file inside the Designer's write scope", () => {
    const paths = role("designer")?.tools.write_paths ?? [];
    const covers = (glob: string, path: string): boolean =>
      glob === path || (glob.endsWith("/**") && path.startsWith(glob.slice(0, -2)));
    expect(paths.some((g) => covers(g, DESIGN_FLOWS_PATH))).toBe(true);
    expect(paths.some((g) => covers(g, DESIGN_SCREENS_PATH))).toBe(true);
  });
});

describe("the Planner's start-tier text (D-cu, D-cv; readings 241, 242)", () => {
  it("names the producers the shared rule routes, and only them", () => {
    const producers = TASK_RUNS.filter((r) => routedByDifficulty(r.role, r.mode));
    expect(producers.map((r) => [r.role, r.mode])).toEqual([
      ["engineer", undefined],
      ["qa", "author"],
    ]);
    const text = renderStartRoles();
    expect(text).toMatch(
      /^The table sets the start tier of the producers only: the Engineer and its discipline profiles, and QA writing the acceptance tests\./,
    );
    expect(text).toMatch(
      /The reviewers \(the Spec Verifier, the QA judge, Security verify, Visual QA, the lens reviewers and the cross-family reviewer\) start on their own role tier, whatever the table says/,
    );
    expect(text).toMatch(
      /except that Security verify and the cross-family reviewer start one tier above it on a high-risk task \(a high-risk tag or `risk: high`\), at most `top`\./,
    );
    // the Spec Verifier always starts on its role tier
    expect(text.split("except that")[1]).not.toMatch(/Spec Verifier/);
  });

  it("follows the shared rules, not a copy of them", () => {
    const allRouted = renderStartRoles({
      routedByDifficulty: () => true,
      reviewerStartTier,
    });
    expect(allRouted).toMatch(/the Spec Verifier/);
    expect(allRouted).not.toMatch(/The reviewers/);
    const noneRaised = renderStartRoles({
      routedByDifficulty,
      reviewerStartTier: (input) => ({ tier: input.roleTier, reason: "role" }),
    });
    expect(noneRaised).not.toMatch(/except/);
    const twoUp = renderStartRoles({
      routedByDifficulty,
      reviewerStartTier: (input) =>
        input.role === "visual_qa" && input.risk !== "none"
          ? { tier: "top", reason: "rule" }
          : { tier: input.roleTier, reason: "role" },
    });
    expect(twoUp).toMatch(
      /except that Visual QA starts two tiers above it on a task with any risk tag or a high-risk tag or `risk: high`, at most `top`\./,
    );
  });

  it("renders the escalation ladder from escalationSteps", () => {
    const text = renderTierEscalation();
    expect(text).toBe(
      "a `low` start runs `low` in round 1, `mid` in round 2 and `top` from round 3; a `mid` start runs `mid` in rounds 1–2 and `top` from round 3; a `top` start stays on `top`",
    );
    expect(escalationSteps("low", 3)).toBe(2);
    const slow = renderTierEscalation((start, round) =>
      Math.floor((round - 1) / (start === "low" ? 3 : 2)),
    );
    expect(slow).toMatch(/^a `low` start runs `low` in rounds 1–3, `mid` in rounds 4–6/);
    expect(TIER_ORDER.at(-1)).toBe("top");
  });

  it("matches every role of the catalogue to its group", () => {
    const ids = loaded.roles.map((r) => r.role.id);
    for (const run of TASK_RUNS) {
      expect(ids, run.role).toContain(run.role);
      if (run.mode !== undefined)
        expect(Object.keys(role(run.role)?.modes ?? {}), run.role).toContain(run.mode);
    }
    // every Engineer profile is a producer, every lens role a reviewer on its own tier
    const engineers = ids.filter((id) => id === "engineer" || id.startsWith("engineer_"));
    expect(engineers.length).toBeGreaterThan(1);
    for (const id of engineers) expect(routedByDifficulty(id), id).toBe(true);
    const lenses = ids.filter((id) => role(id)?.kind === "lens");
    expect(lenses.length).toBeGreaterThan(1);
    for (const id of lenses) {
      expect(routedByDifficulty(id), id).toBe(false);
      expect(reviewerStartTier({ role: id, roleTier: "mid", risk: "high" }).reason, id).toBe(
        "role",
      );
    }
  });

  it.each(HOSTS)("shows the %s agent who the table starts and how tiers escalate", (host) => {
    const body = oneLine(agentBody(host, "vtc-planner"));
    const start = section(body, "Start tier");
    expect(start).toContain(renderStartRoles());
    expect(start).toContain(renderTierEscalation());
    expect(start).not.toMatch(/Engineer, QA and reviewers start on/);
    expect(start).toMatch(/within the task's round cap/);
    expect(PROTOCOL_VARS.routing_roles).toBe(renderStartRoles());
    expect(PROTOCOL_VARS.tier_escalation).toBe(renderTierEscalation());
  });
});

describe("locked-core edits bump MAJOR (D-bm)", () => {
  it("bumps the Architect, the Designer and the Planner", () => {
    expect(role("architect")?.version).toBe("4.0.0");
    expect(role("designer")?.version).toBe("4.0.0");
    expect(role("planner")?.version).toBe("3.0.0");
  });

  it("documents round 6 in the roles README", () => {
    const readme = oneLine(source("roles/README.md"));
    expect(readme).toMatch(/\*\*The coverage loop\*\* \(H-13, reading 237\)/);
    expect(readme).toMatch(/\*\*Flows\*\* \(D-ct, reading 247\(7\)\)/);
    expect(readme).toMatch(/starts the producers only/);
  });
});
