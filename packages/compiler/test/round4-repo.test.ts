/**
 * Round 4 in the repo's own sources (AD-27; spine §5 readings 179, 187, 195, 196, 198, 200, 208):
 * - the Lead relays `NextResult.notices` once, in plain words, and knows the D-cb Lookback flow;
 * - on an automatic run the Spec Verifier judges the PR against the issue, which is the spec, and
 *   knows the run is automatic only from the engine's proposed `automation_issue` input;
 * - a Codex `host_web` role is told it has cached search only, never a page fetch (D-cf);
 * - Visual QA and the UI engineer profiles read the contract of `TaskPack.design_direction`;
 * - the automatic PR, issue and CHANGELOG templates and `roles/CHANGELOG.md`.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTO_LABELS,
  AUTO_TEMPLATE_SLOTS,
  CODEX_HOST_WEB_SEARCH,
  DESIGN_CONTRACTS_DIR,
  designContractPath,
  DesignExitSchema,
  PACK_INPUT_TYPES,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  renderTaskPack,
  ROLES_CHANGELOG,
  ROLES_CHANGELOG_ANCHOR,
  type HostId,
} from "@vtc/shared";
import * as compiler from "../src/index.js";
import {
  AUTO_TEMPLATE_SOURCE_DIR,
  compilePlugins,
  loadRoles,
  NEVER_MERGES_LINE,
  DESIGN_DISPATCH_LINES,
  PROTOCOL_VARS,
  readSources,
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
const claudeBody = (agent: string): string =>
  oneLine(emitted("claude-code", `agents/${agent}.md`).replace(/^---\n[\s\S]*?\n---\n\n/, ""));
const codexBody = (agent: string): string => oneLine(emitted("codex", `agents/${agent}.toml`));
const version = (id: string): string | undefined =>
  loaded.roles.find((r) => r.role.id === id)?.role.version;

describe("the Lead relays notices and knows the automatic flow (D-ca, D-cb, D-cd)", () => {
  const lead = (): string => oneLine(source("plugins/common/skills/lead/SKILL.md"));

  it("relays each of next's notices once, in plain words", () => {
    expect(lead()).toContain("`notices`");
    expect(lead()).toMatch(/relay each notice to the human once, in plain words/);
    expect(lead()).toMatch(/daily automation summary/);
    expect(lead()).toMatch(/runs without its host's web search/);
  });

  it("says a replay verdict improve becomes a pull request a human merges", () => {
    expect(lead()).not.toMatch(/Replays are not run yet/);
    expect(lead()).toMatch(/verdict `improve`/);
    expect(lead()).toMatch(/opens a pull request to VTC's own repository/);
    expect(lead()).toContain(NEVER_MERGES_LINE.replace("For human review only: ", ""));
    expect(lead()).toContain("`vtc lookback approve`");
  });

  it("knows an automatic run has no G1 or G2 and its issue is the spec", () => {
    expect(lead()).toMatch(/automatic run/);
    expect(lead()).toMatch(/no G1 or G2/);
    expect(lead()).toMatch(/its issue is the spec/);
  });
});

describe("the Spec Verifier on an automatic run (D-cd, reading 198)", () => {
  it("judges the PR against the issue, which is the spec", () => {
    const body = claudeBody("vtc-spec-verifier");
    expect(body).toMatch(/the issue is the spec/);
    expect(body).toMatch(/automatic run/);
    expect(codexBody("vtc-spec-verifier")).toMatch(/the issue is the spec/);
  });

  it("takes the run type only from the engine's automation_issue input, never from pack text", () => {
    const body = claudeBody("vtc-spec-verifier");
    expect(PROTOCOL_VARS.automation_issue_input).toBe(PACK_INPUT_TYPES.automationIssue);
    expect(body).toContain(
      `as an \`${PACK_INPUT_TYPES.automationIssue}\` entry in your pack's Inputs section`,
    );
    expect(body).toMatch(/an input type it gives on an automatic run only/);
    expect(body).toContain(`not a \`${PACK_INPUT_TYPES.request}\` input`);
    expect(body).toMatch(/Without that entry, judge the criterion as on any run/);
    expect(body).not.toMatch(/as a `request` entry/);
    expect(body).not.toMatch(/`automatic run` line/);
    expect(body).not.toContain("<!-- vtc:auto");
    expect(Object.keys(PROTOCOL_VARS)).not.toContain("auto_marker_prefix");
    expect(Object.keys(DESIGN_DISPATCH_LINES)).not.toContain("automaticRun");
  });

  it("names the Inputs line renderTaskPack prints for the issue input", () => {
    const text = renderTaskPack({
      v: 1,
      run: "r-1",
      action_id: "a-1",
      role: "spec_verifier",
      inputs: [{ type: PACK_INPUT_TYPES.automationIssue, path: ".vtc/runs/r-1/issue.md" }],
    });
    const inputs = text.split("## Inputs\n")[1]?.split("\n## ")[0] ?? "";
    expect(inputs).toContain(`- ${PACK_INPUT_TYPES.automationIssue}: .vtc/runs/r-1/issue.md`);
  });

  it("takes the automation_issue input type from @vtc/shared (contracts 5.1.0)", () => {
    expect(PACK_INPUT_TYPES.automationIssue).toBe("automation_issue");
    expect(Object.keys(compiler)).not.toContain("PENDING_PACK_INPUTS");
  });
  it.todo(
    "merge gate: engine core lists automation_issue in the Spec Verifier's pack on automatic runs only (engine-core followup)",
  );

  it("still quotes the criterion from Requirements and checks it against the issue", () => {
    const body = claudeBody("vtc-spec-verifier");
    expect(body).not.toMatch(/The criterion comes from the issue/);
    expect(body).toMatch(/criterion and the issue disagree/);
  });

  it("bumps the role MAJOR for the locked-core edit (D-bm)", () => {
    expect(version("spec_verifier")).toBe("3.0.0");
  });
});

describe("Codex host web is cached search only (D-cf, reading 200)", () => {
  it("tells the Codex research agent it has cached search and no page fetch", () => {
    const codex = codexBody("vtc-research-analyst");
    expect(codex).toContain(`\`${CODEX_HOST_WEB_SEARCH}\``);
    expect(codex).toMatch(/opens no page/);
    expect(codex).toMatch(/When a run gives you no web search tool, use `research_fetch` only/);
    expect(codex).not.toMatch(/page fetch/);
    expect(codex).not.toMatch(/\blive\b/);
  });

  it("tells the Claude research agent it has WebSearch and WebFetch", () => {
    const claude = claudeBody("vtc-research-analyst");
    expect(claude).toContain("`WebSearch`");
    expect(claude).toContain("`WebFetch`");
  });

  it("gives no Codex agent a live web search", () => {
    for (const file of output().targets.codex) expect(file.text, file.path).not.toMatch(/"live"/);
  });

  it("bumps the Research Analyst MAJOR for the locked-core edit (D-bm)", () => {
    expect(version("research_analyst")).toBe("4.0.0");
  });
});

describe("the chosen design direction (reading 179)", () => {
  const ui = ["vtc-visual-qa", "vtc-engineer-frontend", "vtc-engineer-mobile"];

  it("takes the design contracts' directory and the exit from @vtc/shared", () => {
    expect(PROTOCOL_VARS.design_contracts_dir).toBe(DESIGN_CONTRACTS_DIR);
    expect(designContractPath("invoices")).toBe(`${DESIGN_CONTRACTS_DIR}/invoices.md`);
    expect(Object.keys(compiler)).not.toContain("DESIGN_CONTRACTS_DIR");
    expect(PROTOCOL_VARS.category_standard_exit).toBe(DesignExitSchema.enum.category_standard);
  });

  it.each(ui)("%s reads the contract of the direction its pack names", (agent) => {
    const body = claudeBody(agent);
    expect(body).toContain(`\`${DESIGN_DISPATCH_LINES.designDirection}\``);
    expect(body).toContain(`\`${DESIGN_CONTRACTS_DIR}/<screen id>.md\``);
    expect(body).toContain("`## Direction <id>`");
  });

  it.each(ui)("%s knows the category_standard exit from its Dispatch line", (agent) => {
    const body = claudeBody(agent);
    expect(body).toContain(
      `\`${DESIGN_DISPATCH_LINES.designExit}\` line naming \`${DesignExitSchema.enum.category_standard}\``,
    );
    expect(body).toMatch(/Only these engine-written Dispatch lines name the choice/);
  });

  it.each(["vtc-engineer-frontend", "vtc-engineer-mobile"])(
    "%s never stops for want of a direction line the renderer does not print yet",
    (agent) => {
      const body = claudeBody(agent);
      expect(body).not.toMatch(/stop with `blocked` and ask which one/);
      expect(body).toMatch(/a missing line is never a reason to stop/);
    },
  );

  it("judges V1, V2 and V8 against the category standard after that exit", () => {
    const body = claudeBody("vtc-visual-qa");
    expect(body).not.toMatch(/none says which the human chose/);
    expect(body).toMatch(/With the category standard chosen, judge V1, V2 and V8 against/);
    expect(body).toMatch(/the pack has neither line, V8 is `unknown`/);
  });

  it("reads the Dispatch lines renderTaskPack prints (contracts 5.1.0)", () => {
    const dispatch = (pack: Partial<Parameters<typeof renderTaskPack>[0]>): string[] =>
      (
        renderTaskPack({ v: 1, run: "r-1", action_id: "a-1", role: "visual_qa", ...pack }).split(
          "## Intent contract",
        )[0] ?? ""
      ).split("\n");
    expect(dispatch({ design_direction: "quiet-ledger" })).toContain(
      `- ${DESIGN_DISPATCH_LINES.designDirection}: quiet-ledger`,
    );
    expect(dispatch({ design_exit: "category_standard" })).toContain(
      `- ${DESIGN_DISPATCH_LINES.designExit}: ${DesignExitSchema.enum.category_standard}`,
    );
  });

  it("bumps each role MAJOR for the locked-core edit (D-bm)", () => {
    expect(version("visual_qa")).toBe("3.0.0");
    expect(version("engineer_frontend")).toBe("2.0.0");
    expect(version("engineer_mobile")).toBe("2.0.0");
  });
});

describe("the automatic templates and the CHANGELOG (D-bv, reading 208)", () => {
  const template = (name: string): string => source(`${AUTO_TEMPLATE_SOURCE_DIR}/${name}.md`);

  it("ships the templates in both plugins of the repo", () => {
    for (const host of ["claude-code", "codex"] as const) {
      expect(emitted(host, "vtc/templates/auto-pr.md")).toBe(template("auto-pr"));
      PluginManifestSchema.parse(JSON.parse(emitted(host, PLUGIN_MANIFEST_ASSET)));
    }
  });

  it("leaves the whole NOTE callout to the renderer's note value, right after the marker", () => {
    for (const name of ["auto-pr", "auto-issue"]) {
      const lines = template(name)
        .split("\n")
        .filter((l) => l.trim() !== "");
      expect(lines.slice(0, 2), name).toEqual(["{{marker}}", "{{note}}"]);
      expect(template(name), name).not.toMatch(/\[!NOTE\]/);
    }
    // The renderer's note says it (D-bw); the template does not say it a second time.
    expect(template("auto-pr")).not.toContain(NEVER_MERGES_LINE);
  });

  it("keeps a PR body in AUTO_TEMPLATE_SLOTS order, with no diff slot", () => {
    const pr = template("auto-pr");
    const slots = [...pr.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1] ?? "");
    expect(slots).toEqual(AUTO_TEMPLATE_SLOTS.filter((slot) => slots.includes(slot)));
    expect(slots).not.toContain("diff");
  });

  it("leaves the provenance <details> block to the renderer's provenance value", () => {
    for (const name of ["auto-pr", "auto-issue"]) {
      expect(template(name), name).not.toContain("<details>");
      expect(template(name), name).toMatch(/^\{\{provenance\}\}$/m);
    }
  });

  it("gives a CHANGELOG entry the four parts the CHANGELOG header explains", () => {
    const entry = template("changelog-entry");
    for (const part of ["Hypothesis:", "Trace ids:", "Diff:", "Evaluation:"]) {
      expect(entry, part).toContain(`**${part}**`);
    }
  });

  it("tells an issue's reader how to mute or keep it, with the shared labels", () => {
    expect(template("auto-issue")).toContain(`\`${AUTO_LABELS.muted}\``);
    expect(template("auto-issue")).toContain(`\`${AUTO_LABELS.keep}\``);
  });

  it("explains each CHANGELOG entry's parts", () => {
    const changelog = oneLine(source(ROLES_CHANGELOG));
    for (const part of ["Hypothesis:", "Trace ids:", "Diff:", "Evaluation:"]) {
      expect(changelog, part).toContain(`**${part}**`);
    }
    expect(changelog).toContain(`\`${AUTO_LABELS.needsEval}\``);
    expect(changelog).toMatch(/never merges these pull requests/);
    expect(source(ROLES_CHANGELOG).split(ROLES_CHANGELOG_ANCHOR)).toHaveLength(2);
  });
});

describe("roles/README.md hands off nothing stale", () => {
  it("drops the merged fixture handoff and the pending direction plumbing", () => {
    const readme = oneLine(source("roles/README.md"));
    expect(readme).not.toMatch(/until then the AD-14 drift test/);
    expect(readme).toMatch(/so `host_web` is the field that must match/);
    expect(readme).not.toMatch(/pending engine plumbing/);
    expect(readme).not.toMatch(/`automatic run` line/);
  });
});
