/**
 * Round 4 in the repo's own sources (AD-27; spine §5 readings 179, 187, 195, 196, 198, 200, 208):
 * - the Lead relays `NextResult.notices` once, in plain words, and knows the D-cb Lookback flow;
 * - on an automatic run the Spec Verifier judges the PR against the issue, which is the spec;
 * - a Codex `host_web` role is told it has cached search only, never a page fetch (D-cf);
 * - Visual QA and the UI engineer profiles read the contract of `TaskPack.design_direction`;
 * - the automatic PR, issue and CHANGELOG templates and `roles/CHANGELOG.md`.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTO_LABELS,
  CODEX_HOST_WEB_SEARCH,
  DESIGN_CONTRACTS_DIR,
  designContractPath,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  renderAutoMarker,
  ROLES_CHANGELOG,
  type HostId,
} from "@vtc/shared";
import * as compiler from "../src/index.js";
import {
  AUTO_TEMPLATE_SOURCE_DIR,
  compilePlugins,
  loadRoles,
  NEVER_MERGES_LINE,
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
  const prefix = renderAutoMarker({ v: 1, kind: "defect", fp: "0".repeat(16) }).split(" ")[1];

  it("judges the PR against the issue, which is the spec", () => {
    const body = claudeBody("vtc-spec-verifier");
    expect(prefix).toBe("vtc:auto");
    expect(body).toContain(`\`<!-- ${String(prefix)}\``);
    expect(body).toMatch(/the issue is the spec/);
    expect(body).toMatch(/automatic run/);
    expect(codexBody("vtc-spec-verifier")).toMatch(/the issue is the spec/);
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
  it("takes the design contracts' directory from @vtc/shared", () => {
    expect(PROTOCOL_VARS.design_contracts_dir).toBe(DESIGN_CONTRACTS_DIR);
    expect(designContractPath("invoices")).toBe(`${DESIGN_CONTRACTS_DIR}/invoices.md`);
    expect(Object.keys(compiler)).not.toContain("DESIGN_CONTRACTS_DIR");
  });

  it.each(["vtc-visual-qa", "vtc-engineer-frontend", "vtc-engineer-mobile"])(
    "%s reads the contract of the direction its pack names",
    (agent) => {
      const body = claudeBody(agent);
      expect(body).toContain("`design direction`");
      expect(body).toContain(`\`${DESIGN_CONTRACTS_DIR}/<screen id>.md\``);
      expect(body).toContain("`## Direction <id>`");
    },
  );

  it("drops Visual QA's guess when the pack names the direction", () => {
    expect(claudeBody("vtc-visual-qa")).not.toMatch(/none says which the human chose/);
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

  it("says in every PR that VTC never merges it", () => {
    expect(template("auto-pr")).toContain(NEVER_MERGES_LINE);
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
  });
});

describe("roles/README.md hands off nothing stale", () => {
  it("drops the merged fixture handoff and the pending direction plumbing", () => {
    const readme = oneLine(source("roles/README.md"));
    expect(readme).not.toMatch(/until then the AD-14 drift test/);
    expect(readme).toMatch(/so `host_web` is the field that must match/);
    expect(readme).not.toMatch(/pending engine plumbing/);
  });
});
