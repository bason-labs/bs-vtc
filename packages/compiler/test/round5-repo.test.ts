/**
 * Round 5 in the repo's own sources (H-9, D-cm, D-cs; spine §5 readings 218 and 221):
 * - the Planner knows how the engine picks each task's start tier (`DEFAULT_ROUTING_TABLE`) and
 *   sets a reason-coded `tier_hint` only when that table clearly misjudges a task;
 * - every role that raises a question names a missing capability (`Question.missing_capability`)
 *   when that is what blocks it, through the shared result protocol, not per role;
 * - the Lead records the capability the human's answer shows was missing.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_TABLE,
  ModelTierSchema,
  QA_AUTHOR_MIN_TIER,
  QuestionSchema,
  RoutingTableSchema,
  TaskDraftSchema,
  TierHintReasonSchema,
  type HostId,
  type RoutingTable,
  type TaskDraftInput,
} from "@vtc/shared";
import {
  AUTO_TEMPLATE_LAYOUT,
  compilePlugins,
  loadRoles,
  PROTOCOL_VARS,
  readSources,
  renderRoutingTable,
  TIER_HINT_REASON_DIRECTION,
  type CompileOutput,
} from "../src/index.js";
import { routingStartTier } from "../src/routing.js";

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
const version = (id: string): string | undefined =>
  loaded.roles.find((r) => r.role.id === id)?.role.version;
const HOSTS: readonly HostId[] = ["claude-code", "codex"];
/**
 * D-cm's table as decided (spine §5 reading 218(2)): the rule and rendering tests read it, since
 * `DEFAULT_ROUTING_TABLE`'s tiers move through reviewed D-cn routing PRs that change
 * `tier-routing.ts` only (reading 233); what the Planner is shown is checked against the default.
 */
const DCM: RoutingTable = {
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
};

describe("the routing table as the Planner reads it (D-cm, reading 218)", () => {
  it("starts S untagged Low, M or a tagged S Mid, L or any high-risk tag Top", () => {
    const t = DCM;
    expect(routingStartTier(t, "S", "none")).toBe("low");
    expect(routingStartTier(t, "S", "tagged")).toBe("mid");
    expect(routingStartTier(t, "M", "none")).toBe("mid");
    expect(routingStartTier(t, "M", "tagged")).toBe("mid");
    expect(routingStartTier(t, "L", "none")).toBe("top");
    for (const size of ["S", "M", "L"] as const) {
      expect(routingStartTier(t, size, "high"), size).toBe("top");
    }
  });

  it("treats the floors as floors: a bigger size keeps its own higher tier", () => {
    const t = RoutingTableSchema.parse({
      ...DCM,
      by_size: { S: "low", M: "top", L: "top" },
      tagged_floor: "mid",
      high_floor: "mid",
    });
    expect(routingStartTier(t, "M", "tagged")).toBe("top");
    expect(routingStartTier(t, "M", "high")).toBe("top");
    expect(routingStartTier(t, "S", "high")).toBe("mid");
  });

  it("renders every cell, the high-risk tags and `risk: high` from the table", () => {
    const text = renderRoutingTable(DCM);
    expect(text).toContain("| S | `low` | `mid` | `top` |");
    expect(text).toContain("| M | `mid` | `mid` | `top` |");
    expect(text).toContain("| L | `top` | `top` | `top` |");
    for (const tag of DCM.high_risk_tags) expect(text, tag).toContain(`\`${tag}\``);
    expect(text).toContain("`risk: high`");
  });

  it("follows the table's values, not a hand-typed copy", () => {
    const changed = RoutingTableSchema.parse({
      ...DCM,
      by_size: { S: "mid", M: "mid", L: "top" },
      high_risk_tags: ["auth", "billing"],
    });
    const text = renderRoutingTable(changed);
    expect(text).toContain("| S | `mid` | `mid` | `top` |");
    expect(text).toContain("`billing`");
    expect(text).not.toContain("`payments`");
  });

  it("says which roles depart from the shared cells when a reviewed change added some", () => {
    expect(renderRoutingTable(DCM)).not.toMatch(/start differently/);
    const withRole = RoutingTableSchema.parse({
      ...DCM,
      roles: { visual_qa: { by_size: { S: "mid" } } },
    });
    expect(renderRoutingTable(withRole)).toMatch(
      /start differently in some cells \(the engine applies them\): `visual_qa`\./,
    );
  });

  it("puts every hint reason on exactly one side, raising or lowering", () => {
    expect(Object.keys(TIER_HINT_REASON_DIRECTION).sort()).toEqual(
      [...TierHintReasonSchema.options].sort(),
    );
    expect(TIER_HINT_REASON_DIRECTION.cross_cutting).toBe("raise");
    expect(TIER_HINT_REASON_DIRECTION.mechanical).toBe("lower");
  });

  it("fills the Planner's placeholders from @vtc/shared", () => {
    expect(PROTOCOL_VARS.routing_table).toBe(renderRoutingTable(DEFAULT_ROUTING_TABLE));
    expect(PROTOCOL_VARS.high_risk_tags).toBe(
      DEFAULT_ROUTING_TABLE.high_risk_tags.map((t) => `\`${t}\``).join(", "),
    );
    expect(PROTOCOL_VARS.model_tiers).toBe(
      ModelTierSchema.options.map((t) => `\`${t}\``).join(", "),
    );
    expect(PROTOCOL_VARS.qa_author_min_tier).toBe(`\`${QA_AUTHOR_MIN_TIER}\``);
    const reasons = `${PROTOCOL_VARS.tier_hint_raise_reasons ?? ""}, ${PROTOCOL_VARS.tier_hint_lower_reasons ?? ""}`;
    expect(reasons.split(", ").sort()).toEqual(
      TierHintReasonSchema.options.map((r) => `\`${r}\``).sort(),
    );
  });
});

describe("the Planner's tier_hint (H-9, D-cm, reading 218)", () => {
  it.each(HOSTS)("names every TierHintReason code in the compiled %s agent", (host) => {
    const body = agentBody(host, "vtc-planner");
    for (const reason of TierHintReasonSchema.options) {
      expect(body, reason).toContain(`\`${reason}\``);
    }
  });

  it.each(HOSTS)("shows the %s agent the routing table and its rules", (host) => {
    const body = oneLine(agentBody(host, "vtc-planner"));
    // the default table's own cells, whatever a reviewed routing PR made them
    for (const size of ["S", "M", "L"]) {
      const row = renderRoutingTable(DEFAULT_ROUTING_TABLE)
        .split("\n")
        .find((l) => l.startsWith(`| ${size} |`));
      expect(row, size).toMatch(/^\| [SML] \| `(low|mid|top)` \|/);
      expect(body, size).toContain(row);
    }
    expect(body).toContain("`risk: high` counts as a high-risk tag");
    for (const tag of DEFAULT_ROUTING_TABLE.high_risk_tags)
      expect(body, tag).toContain(`\`${tag}\``);
    expect(body).toContain("`tier_hint`");
    expect(body).toMatch(/only when the table clearly misjudges the task/);
    expect(body).toMatch(/Most tasks carry no `tier_hint`/);
    expect(body).toMatch(/one sentence/);
    expect(body).toMatch(/QA writing a task's acceptance tests never starts below `mid`/);
  });

  it("asks the Planner to tag the areas the routing table treats as high risk", () => {
    const locked = oneLine(
      source("roles/planner/prompt.md").split("<!-- vtc:editable -->")[0] ?? "",
    );
    expect(locked).toContain("{{high_risk_tags}}");
    expect(locked).toMatch(/`risk_tags`/);
    // The rendered list is the only list of high-risk tags: a reviewed change to the table's
    // values (D-cn) reaches step 8 with no hand edit, so step 8 names none of them by hand.
    const step8 = locked.split(" 8. ")[1]?.split(" 9. ")[0] ?? "";
    expect(step8).toContain("{{high_risk_tags}}");
    for (const tag of DEFAULT_ROUTING_TABLE.high_risk_tags) {
      expect(step8.replace("{{high_risk_tags}}", ""), tag).not.toMatch(new RegExp(`\\b${tag}\\b`));
    }
  });

  it("lists tier_hint among the task draft's fields", () => {
    const body = oneLine(agentBody("claude-code", "vtc-planner"));
    const outputSection = body.split("## Output")[1]?.split("## Rules")[0] ?? "";
    expect(outputSection).toContain("`tier_hint`");
  });

  it("bumps the Planner MAJOR for the locked-core edit (D-bm)", () => {
    expect(version("planner")).toBe("2.0.0");
  });

  const draft: TaskDraftInput = {
    id: "T-1",
    title: "Rename the config loader's options",
    covers: ["REQ-1"],
    files_scope: ["src/config/**"],
    discipline: "backend",
    risk: "low",
    size: "M",
    arch_triage: "fits",
    intent: {
      statement: "Quote REQ-1: the loader reads `timeout_ms`.",
      always: ["keep the old key working"],
      never: ["change the default"],
      io_matrix: [{ case: "old key", input: "timeout: 5", expected: "5000 ms" }],
    },
  };

  it("validates a TaskDraft without a tier_hint", () => {
    const parsed = TaskDraftSchema.parse(draft);
    expect(parsed.tier_hint).toBeUndefined();
  });

  it("validates a TaskDraft with a tier_hint, with and without its detail", () => {
    const hinted = TaskDraftSchema.parse({
      ...draft,
      tier_hint: {
        tier: "low",
        reason: "mechanical",
        detail: "A rename across three files with no new logic.",
      },
    });
    expect(hinted.tier_hint).toEqual({
      tier: "low",
      reason: "mechanical",
      detail: "A rename across three files with no new logic.",
    });
    expect(
      TaskDraftSchema.safeParse({ ...draft, tier_hint: { tier: "top", reason: "concurrency" } })
        .success,
    ).toBe(true);
  });

  it("rejects a tier_hint whose reason is not a TierHintReason code", () => {
    const bad = TaskDraftSchema.safeParse({
      ...draft,
      tier_hint: { tier: "top", reason: "feels_hard" },
    });
    expect(bad.success).toBe(false);
  });
});

describe("missing capabilities in questions (D-cs, reading 221)", () => {
  const QUESTION_ROLES = [
    "vtc-engineer-backend",
    "vtc-engineer-frontend",
    "vtc-qa-author",
    "vtc-qa-judge",
    "vtc-spec-verifier",
    "vtc-security-verify",
    "vtc-visual-qa",
    "vtc-lens-auth",
    "vtc-research-analyst",
  ];

  it("explains missing_capability once, in the shared result protocol", () => {
    const protocol = oneLine(source("roles/_shared/result-protocol.md"));
    expect(protocol).toContain("`missing_capability`");
    expect(protocol).toMatch(/`slug`/);
    expect(protocol).toMatch(/`reason`/);
    expect(protocol).toMatch(/a capability you lack \(a tool, an engine fetcher, a runner\)/);
    expect(protocol).toMatch(/Otherwise leave it out/);
    // One separator, as the shared MissingCapability examples use, so repeats count together.
    expect(protocol).toMatch(/words joined by `_` only/);
    const perRole = read.files.filter(
      (f) => /^roles\/[^_][^/]*\/prompt\.md$/.test(f.path) && f.text.includes("missing_capability"),
    );
    expect(perRole.map((f) => f.path)).toEqual([]);
  });

  it.each(HOSTS)("reaches every %s agent that raises questions", (host) => {
    for (const agent of QUESTION_ROLES) {
      const body = agentBody(host, agent);
      expect(body, `${host} ${agent}`).not.toBe("");
      expect(body, `${host} ${agent}`).toContain("`missing_capability`");
    }
  });

  it("gives a slug the shared Question contract accepts", () => {
    const question = {
      question: "No browser runner is available for the e2e tests. How should I proceed?",
      options: [
        { id: "drop", label: "Drop the e2e tests from this task", effect: "drop" },
        { id: "replan", label: "Plan a task that adds a runner", effect: "replan" },
      ],
      recommended: "replan",
      evidence: [{ type: "spec_ref", ref: "REQ-1.AC-1" }],
      missing_capability: { slug: "browser_runner", reason: "The e2e tests need a browser." },
    };
    expect(QuestionSchema.safeParse(question).success).toBe(true);
    const { missing_capability: _omitted, ...without } = question;
    expect(QuestionSchema.safeParse(without).success).toBe(true);
  });

  it("has the Lead record a capability the human's answer shows was missing", () => {
    const lead = oneLine(source("plugins/common/skills/lead/SKILL.md"));
    expect(lead).toMatch(/`missing_capability`/);
    expect(lead).toMatch(/only when the answer shows the role lacked a capability/);
    expect(lead).toMatch(/words joined by `_` only/);
  });
});

describe("the templates match what the upstream renderer fills (merge cross-check)", () => {
  const template = (name: string): string => source(`plugins/common/templates/${name}.md`);
  const slotsOf = (text: string): string[] =>
    [...text.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1] ?? "");

  it("gives an issue the per-kind reviewer checklist the renderer always fills, last", () => {
    expect(AUTO_TEMPLATE_LAYOUT["auto-issue"]).toEqual([
      "marker",
      "note",
      "summary",
      "why",
      "evidence",
      "provenance",
      "checklist",
    ]);
    expect(slotsOf(template("auto-issue"))).toEqual(AUTO_TEMPLATE_LAYOUT["auto-issue"]);
    expect(template("auto-issue")).toMatch(/## Reviewer checklist\n\n\{\{checklist\}\}\n$/);
  });

  it("puts a prompt PR's diff right after the changes, as the shared doc and the renderer do", () => {
    // AUTO_TEMPLATE_SLOTS doc: "`diff` is a prompt PR's fenced diff and follows `changes`"; the
    // upstream module fills it in a prompt PR's body and drops it first when the body is too long.
    const pr = slotsOf(template("auto-pr"));
    expect(pr).toEqual(AUTO_TEMPLATE_LAYOUT["auto-pr"]);
    expect(pr.slice(pr.indexOf("changes"), pr.indexOf("changes") + 2)).toEqual(["changes", "diff"]);
    expect(template("auto-pr")).toMatch(/^\{\{diff\}\}$/m);
    expect(slotsOf(template("changelog-entry"))).toContain("diff");
  });
});
