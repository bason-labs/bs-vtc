/**
 * Advisors (spec §5.4, Tier 3, "called through the Lead"; spine §5 readings 25 and 30): on-demand
 * agents the Lead dispatches through the engine's `consult` tool when the human asks, so every
 * call is logged, priced and budgeted and its result checked on `submit`. Their reviewer is the
 * human; they are read-only except for a client export written under `.vtc/exports/**`.
 */
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  EvidenceTypeSchema,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  ROLE_CONTRACTS_ASSET,
  RoleContractSchema,
  SUMMARY_MAX_CHARS,
} from "@vtc/shared";
import {
  ADVISOR_EXITS,
  ADVISOR_EXPORT_ARTIFACT,
  ADVISOR_REVIEWER,
  ADVISOR_WRITE_PATHS,
  advisorContractErrors,
  compilePlugins,
  loadRoles,
  type CompileOutput,
} from "../src/index.js";
import { ADVISOR_FIXTURE, fixtureFiles } from "./fixtures.js";

const withAdvisor = (overrides: Record<string, string | null> = {}) =>
  fixtureFiles({ ...ADVISOR_FIXTURE, ...overrides });

const compileOk = (overrides: Record<string, string | null> = {}): CompileOutput => {
  const result = compilePlugins(withAdvisor(overrides));
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  return result.output;
};

const errorsOf = (overrides: Record<string, string | null>): string => {
  const result = compilePlugins(withAdvisor(overrides));
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
};

const text = (output: CompileOutput, host: "claude-code" | "codex", path: string): string =>
  output.targets[host].find((f) => f.path === path)?.text ?? "";

const estimatorYaml = ADVISOR_FIXTURE["roles/advisor_estimator/role.yaml"] ?? "";
const estimator = (from: string, to: string): Record<string, string> => ({
  "roles/advisor_estimator/role.yaml": estimatorYaml.replace(from, to),
});

describe("advisor agents (§5.4)", () => {
  const output = compileOk();
  const claude = text(output, "claude-code", "agents/vtc-advisor-estimator.md");
  const codex = parseToml(text(output, "codex", "agents/vtc-advisor-estimator.toml"));
  const codexText = (key: string): string => {
    const value = codex[key];
    return typeof value === "string" ? value : "";
  };

  it("compiles one read-only agent per advisor on both hosts", () => {
    expect(claude).toMatch(/^tools: Read, Grep, Glob$/m);
    expect(codex.sandbox_mode).toBe("read-only");
    expect((codex.mcp_servers as Record<string, { enabled?: boolean }>).vtc?.enabled).toBe(false);
  });

  it("tells the host the agent runs only at the human's request, through the engine's consult", () => {
    expect(claude).toMatch(/^description: .*advisor advisor_estimator: .*human asks/m);
    expect(codexText("description")).toContain("only when the VTC Lead consults it");
    expect(codexText("description")).toContain("consult");
    expect(codexText("description")).not.toContain("dispatches it for the engine");
  });

  it("uses the advisor protocol, not the task-pack result protocol", () => {
    const body = codexText("developer_instructions");
    expect(body).toContain("## Returning your advice");
    expect(body).not.toContain("## Returning your result");
    expect(body).toContain(`Evidence types: ${EvidenceTypeSchema.options.join(", ")}.`);
    expect(body).toContain(`At most ${String(SUMMARY_MAX_CHARS)} characters.`);
  });

  it("states in its contract that the engine checks the result and the human reads the advice", () => {
    const body = codexText("developer_instructions");
    const order = ["ESTIMATOR-LOCKED", "## Contract", "## Returning your advice"];
    const at = order.map((needle) => body.indexOf(needle));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body).toContain("The engine checks your result against it");
    expect(body).toContain("the human who asked reads your advice");
    expect(body).toContain("- Inputs (artifact types in your task pack): request");
    expect(body).not.toContain("the Lead's request may list");
    expect(body.indexOf("ESTIMATOR-EDITABLE")).toBeGreaterThan(at[2] ?? 0);
  });

  it("lists the advisor in the manifest with kind advisor and in the role contracts", () => {
    const manifest = PluginManifestSchema.parse(
      JSON.parse(text(output, "codex", PLUGIN_MANIFEST_ASSET)),
    );
    expect(manifest.agents.find((a) => a.role === "advisor_estimator")?.kind).toBe("advisor");
    const contracts = (JSON.parse(text(output, "codex", ROLE_CONTRACTS_ASSET)) as unknown[]).map(
      (c) => RoleContractSchema.parse(c),
    );
    expect(contracts.find((c) => c.id === "advisor_estimator")?.reviewer).toBe("human");
  });

  it("compiles a client-export advisor write-scoped to the exports directory (reading 30)", () => {
    const liaison = compileOk({
      "roles/advisor_estimator/role.yaml": estimatorYaml
        .replace("artifacts: []", "artifacts: [client_export]")
        .replace(
          "tools: { profile: read_only }",
          'tools: { profile: write_scoped, write_paths: [".vtc/exports/**"] }',
        ),
    });
    const md = text(liaison, "claude-code", "agents/vtc-advisor-estimator.md");
    expect(md).toMatch(/^tools: Read, Grep, Glob, Write, Edit$/m);
    expect(md).toContain("- Write paths (role.yaml): .vtc/exports/**");
    expect(md).toContain("- Output artifact types: client_export");
    const toml = parseToml(text(liaison, "codex", "agents/vtc-advisor-estimator.toml"));
    expect(toml.sandbox_mode).toBe("workspace-write");
  });

  it("needs the shared advisor protocol", () => {
    expect(errorsOf({ "roles/_shared/advisor-protocol.md": null })).toContain(
      "roles/advisor_estimator: advisor roles build on roles/_shared/advisor-protocol.md, which is missing",
    );
  });
});

describe("advisor contract rules", () => {
  it("exports the rules the Lead skill relies on", () => {
    expect(ADVISOR_REVIEWER).toBe("human");
    expect(ADVISOR_EXITS).toEqual(["done", "blocked", "unknown"]);
    expect(ADVISOR_WRITE_PATHS).toEqual([".vtc/exports/**"]);
    expect(ADVISOR_EXPORT_ARTIFACT).toBe("client_export");
  });

  it.each([
    [
      "an advisor id without the advisor_ prefix",
      { "roles/advisor_estimator/role.yaml": null, "roles/advisor_estimator/prompt.md": null },
      {
        "roles/estimator/role.yaml": estimatorYaml.replace(
          "id: advisor_estimator",
          "id: estimator",
        ),
        "roles/estimator/prompt.md": "<!-- vtc:locked -->\nX\n<!-- vtc:editable -->\nY\n",
      },
      "roles/estimator: advisor role ids start with advisor_",
    ],
    [
      "a run role under the advisor_ prefix",
      {},
      {
        "roles/advisor_estimator/role.yaml": estimatorYaml
          .replace("kind: advisor", "kind: core")
          .replace("reviewer: human", "reviewer: engine"),
      },
      "roles/advisor_estimator: only advisors (kind advisor) may use the advisor_ prefix",
    ],
    [
      "an advisor write-scoped outside the exports directory",
      {},
      {
        "roles/advisor_estimator/role.yaml": estimatorYaml
          .replace("artifacts: []", "artifacts: [client_export]")
          .replace(
            "tools: { profile: read_only }",
            'tools: { profile: write_scoped, write_paths: [".vtc/exports/**", "docs/**"] }',
          ),
      },
      "roles/advisor_estimator: advisors are read_only, or write_scoped to .vtc/exports/** only (spine §5 reading 30)",
    ],
    [
      "a code-sandboxed advisor",
      {},
      estimator("tools: { profile: read_only }", "tools: { profile: code_sandboxed }"),
      "only the Engineer family may use code_sandboxed",
    ],
    [
      "an advisor with an output artifact other than client_export",
      {},
      estimator("artifacts: []", "artifacts: [spec]"),
      "roles/advisor_estimator: advisor output artifacts: none when read_only, exactly client_export when write_scoped",
    ],
    [
      "a read-only advisor that claims a client export",
      {},
      estimator("artifacts: []", "artifacts: [client_export]"),
      "roles/advisor_estimator: advisor output artifacts: none when read_only, exactly client_export when write_scoped",
    ],
    [
      "a write-scoped advisor without the client export artifact",
      {},
      estimator(
        "tools: { profile: read_only }",
        'tools: { profile: write_scoped, write_paths: [".vtc/exports/**"] }',
      ),
      "roles/advisor_estimator: advisor output artifacts: none when read_only, exactly client_export when write_scoped",
    ],
    [
      "an advisor with verdicts",
      {},
      estimator("verdicts: []", "verdicts: [pass]"),
      "roles/advisor_estimator: advisors return advice, not verdicts",
    ],
    [
      "an advisor reviewed by a role",
      {},
      estimator("reviewer: human", "reviewer: engine"),
      "roles/advisor_estimator: an advisor's reviewer is human",
    ],
    [
      "an advisor with an exit outside done, blocked and unknown",
      {},
      estimator("exits: [done, blocked, unknown]", "exits: [done, spec_conflict]"),
      "roles/advisor_estimator: advisor exits are done, blocked, unknown; not spec_conflict",
    ],
    [
      "an advisor with engine-checked success criteria",
      {},
      estimator(
        "reviewer: human",
        'success_criteria:\n  - { id: math, description: "Sums add up." }\nreviewer: human',
      ),
      "roles/advisor_estimator: advisors declare no success_criteria: the engine runs no success checks on advice",
    ],
    [
      "an advisor with modes",
      {},
      estimator(
        "budget: { context_tokens: 40000 }",
        "budget: { context_tokens: 40000 }\nmodes:\n  quick: { exits: [done] }",
      ),
      "roles/advisor_estimator: advisors declare no modes",
    ],
  ])("rejects %s", (_name, remove, add, message) => {
    expect(errorsOf({ ...remove, ...add })).toContain(message);
  });

  it("passes every advisor of the fixture and every non-advisor role", () => {
    const loaded = loadRoles(withAdvisor());
    expect(loaded.ok).toBe(true);
    for (const r of loaded.roles) expect(advisorContractErrors(r.role), r.role.id).toEqual([]);
  });
});
