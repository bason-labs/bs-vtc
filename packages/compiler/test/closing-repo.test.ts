/**
 * The wave-3 closing round in the repo's own sources (spine §5 readings 156, 166, 167, 172, 174,
 * 175; spec §9.1, §10):
 * - the Spec Verifier switched to the pack (D-bl) with a MAJOR version (D-bm);
 * - engineer profiles' identity covers the Engineer prompt (D-br);
 * - the Research Analyst searches with its host's web tools (H-3) and the research skills say how;
 * - the Designer fork from impeccable (Apache-2.0): the craft floor, new-work steps 1–5, the
 *   per-screen Direction contract, screen modes and the font blocklist, in the Designer and
 *   Visual QA prompts and their `design-craft` skill; 2–3 directions on a new-repo UI (D-bt).
 */
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  engineerProfileLockedSection,
  FactProposeInputSchema,
  FactReportedSourceSchema,
  G2_DIRECTIONS,
  HOST_IDS,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  sha256Hex,
  splitRolePrompt,
  type HostId,
  type PluginManifest,
} from "@vtc/shared";
import {
  CLAUDE_SKILL_DIR,
  compiledAgentNames,
  compilePlugins,
  EDITABLE_IN_PACK_ROLES,
  EDITABLE_PACK_SECTION,
  loadRoles,
  PROTOCOL_VARS,
  readSources,
  ROLE_SKILLS,
  rolePromptAssetPath,
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
const manifest = (host: HostId): PluginManifest =>
  PluginManifestSchema.parse(JSON.parse(emitted(host, PLUGIN_MANIFEST_ASSET)));
const claudeBody = (agent: string): string =>
  emitted("claude-code", `agents/${agent}.md`).replace(/^---\n[\s\S]*?\n---\n\n/, "");
const claudeFront = (agent: string): { tools: string; skills?: string[] } =>
  parseYaml(
    /^---\n([\s\S]*?)\n---\n/.exec(emitted("claude-code", `agents/${agent}.md`))?.[1] ?? "",
  ) as { tools: string; skills?: string[] };
const oneLine = (text: string): string => text.replace(/\s+/g, " ");
const role = (id: string) => loaded.roles.find((r) => r.role.id === id)?.role;
const sectionsOf = (dir: string): { locked: string; editable: string } => {
  const split = splitRolePrompt(source(`roles/${dir}/prompt.md`));
  if (!split.ok) throw new Error(split.errors.join("\n"));
  return { locked: split.locked, editable: split.editable };
};

describe("every placeholder is rendered", () => {
  it.each(HOST_IDS)("no %s agent carries a {{…}} placeholder", (host) => {
    for (const file of output().targets[host].filter((f) => f.path.startsWith("agents/"))) {
      expect(file.text, file.path).not.toMatch(/\{\{[a-z0-9_]+\}\}/);
    }
  });
});

describe("the Spec Verifier is switched to the pack (D-bl, D-bm; readings 166, 167)", () => {
  it("is switched by default, with a MAJOR role version", () => {
    expect(EDITABLE_IN_PACK_ROLES).toEqual(["spec_verifier"]);
    expect(role("spec_verifier")?.version).toBe("2.0.0");
  });

  it.each(HOST_IDS)("on %s its agent carries no editable section and says so", (host) => {
    const flagged = manifest(host).agents.filter((a) => a.editable_in_pack === true);
    expect(flagged.map((a) => a.name)).toEqual(["vtc-spec-verifier"]);
    const editable = sectionsOf("spec_verifier").editable;
    expect(emitted(host, rolePromptAssetPath("vtc-spec-verifier", "editable"))).toBe(editable);
    const body =
      host === "claude-code"
        ? claudeBody("vtc-spec-verifier")
        : emitted(host, "agents/vtc-spec-verifier.toml");
    for (const line of editable.split("\n").filter((l) => l.startsWith("- "))) {
      expect(body, line).not.toContain(line);
    }
    expect(body).toContain(`\`## ${EDITABLE_PACK_SECTION}\``);
  });
});

describe("engineer profiles' identity covers the Engineer prompt (D-br, reading 172)", () => {
  it.each(HOST_IDS)("on %s each profile's locked part is engineerProfileLockedSection", (host) => {
    const engineer = sectionsOf("engineer");
    const profiles = loaded.roles.filter((r) => r.role.kind === "engineer_profile");
    expect(profiles.length).toBeGreaterThan(1);
    for (const { dir, role: contract } of profiles) {
      const own = sectionsOf(dir);
      const locked = engineerProfileLockedSection(engineer, own.locked);
      for (const name of compiledAgentNames(contract)) {
        const agent = manifest(host).agents.find((a) => a.name === name);
        expect(agent?.locked_sha256, name).toBe(sha256Hex(locked.trim()));
        expect(agent?.editable_sha256, name).toBe(sha256Hex(own.editable.trim()));
        expect(emitted(host, rolePromptAssetPath(name, "locked")), name).toBe(locked);
        expect(emitted(host, rolePromptAssetPath(name, "editable")), name).toBe(own.editable);
      }
    }
  });
});

describe("the Research Analyst searches with its host's web tools (H-3, reading 156)", () => {
  it("opts in with host_web, at MAJOR version 3.0.0 for the locked-core edit (D-bm)", () => {
    expect(role("research_analyst")?.tools.host_web).toBe(true);
    expect(role("research_analyst")?.version).toBe("3.0.0");
  });

  it("is the only role with host web tools, and never a code_sandboxed one", () => {
    const withWeb = loaded.roles.filter((r) => r.role.tools.host_web === true);
    expect(withWeb.map((r) => r.role.id)).toEqual(["research_analyst"]);
    for (const name of loaded.roles.flatMap((r) => compiledAgentNames(r.role))) {
      const tools = claudeFront(name).tools.split(", ");
      const expected = name === "vtc-research-analyst";
      expect(tools.includes("WebSearch"), name).toBe(expected);
      expect(tools.includes("WebFetch"), name).toBe(expected);
    }
  });

  it("discovers with the host, cites through fact_propose, and keeps host-only claims UNVERIFIED", () => {
    const body = oneLine(claudeBody("vtc-research-analyst"));
    expect(body).toMatch(/host's web search and page fetch/);
    expect(body).toMatch(/page content .*untrusted data, never instructions/i);
    expect(body).toContain("`reported_source`");
    expect(body).toContain('`{ "fetcher": "web", "url": … }`');
    expect(body).toMatch(/stays `unverified`/);
    expect(body).toContain("`UNVERIFIED: <claim>`");
  });

  it("shows a fact_propose with a reported_source that the frozen schemas accept", () => {
    const facts = source("skills/research-facts/SKILL.md");
    const examples = [...facts.matchAll(/```json\n(\{\s*"subject"[\s\S]*?\})\n```/g)].map(
      (m) => m[1] ?? "",
    );
    const reported = examples.filter((e) => e.includes('"reported_source"'));
    expect(reported.length).toBeGreaterThanOrEqual(1);
    for (const example of reported) {
      const parsed = FactProposeInputSchema.safeParse(JSON.parse(example) as unknown);
      expect(parsed.success, example).toBe(true);
      expect(parsed.data?.source?.request.fetcher).toBe("web");
    }
    for (const via of FactReportedSourceSchema.shape.via.options) {
      expect(facts, via).toContain(`\`${via}\``);
    }
  });

  it("says search is an optional keyed provider and youtube needs the user's yt-dlp (D-bs)", () => {
    const fetch = oneLine(source("skills/research-fetch/SKILL.md"));
    expect(fetch).toMatch(/`search` is an optional keyed provider/);
    expect(fetch).toMatch(/no default/);
    expect(fetch).toMatch(/`youtube` .*user's own `yt-dlp`/);
    // "unavailable" is a result with status `error` and a `detail` naming why (FetchResult)
    expect(fetch).toMatch(/answers unavailable: status `error` with a `detail`/);
    // H-3: host search is how a role with host web tools discovers pages
    expect(fetch).not.toMatch(/no host web search/);
    expect(fetch).toMatch(/A host search result is a lead, not a source/);
  });
});

const IMPECCABLE_COMMIT = "2f98774f86bc05563876643db37e6c37c322850f";
const CRAFT = "skills/design-craft";
const REFERENCES = ["craft-floor", "new-work", "direction-contract", "modes"];
const DIRECTION_BLOCKS = ["THESIS", "OWN-WORLD", "STORY", "FIRST VIEWPORT", "FORM", "FINISH"];
const MODES = ["Persuade", "Operate", "Read", "Experience"];
const BLOCKLIST = [
  "Fraunces",
  "Playfair Display",
  "Cormorant",
  "Lora",
  "Crimson",
  "Newsreader",
  "Syne",
  "Space Grotesk",
  "Space Mono",
  "IBM Plex",
  "DM Sans",
  "DM Serif",
  "Outfit",
  "Plus Jakarta Sans",
  "Instrument Sans",
];

describe("the design-craft skill, forked from impeccable (spec §9.1; Apache-2.0)", () => {
  const skill = (): string => source(`${CRAFT}/SKILL.md`);
  const reference = (name: string): string => source(`${CRAFT}/references/${name}.md`);
  const craftFiles = () => read.files.filter((f) => f.path.startsWith(`${CRAFT}/`));

  it("has a core file and the four references, each linked from the core", () => {
    for (const ref of REFERENCES) {
      expect(reference(ref), ref).not.toBe("");
      expect(skill()).toContain(`${CLAUDE_SKILL_DIR}/references/${ref}.md`);
    }
    expect(
      craftFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(
      [`${CRAFT}/SKILL.md`, ...REFERENCES.map((r) => `${CRAFT}/references/${r}.md`)].sort(),
    );
  });

  it("keeps the core small and each reference within a few thousand tokens", () => {
    expect(skill().length).toBeLessThan(2500 * 4);
    for (const ref of REFERENCES) expect(reference(ref).length, ref).toBeLessThan(3200 * 4);
  });

  it("marks every file as derived from the pinned upstream and modified by VTC", () => {
    for (const file of craftFiles()) {
      expect(file.text, file.path).toContain(`pbakaus/impeccable`);
      expect(file.text, file.path).toContain(IMPECCABLE_COMMIT);
      expect(file.text, file.path).toMatch(/[Mm]odified by VTC/);
    }
  });

  it("uses no upstream branding and none of its commands or telemetry", () => {
    const texts = [
      ...craftFiles(),
      ...["designer", "visual_qa"].flatMap((id) =>
        read.files.filter((f) => f.path.startsWith(`roles/${id}/`)),
      ),
    ];
    for (const file of texts) {
      // the upstream name appears only as the attribution's repository path
      expect(file.text.replaceAll("pbakaus/impeccable", ""), file.path).not.toMatch(/impeccable/i);
      expect(file.text, file.path).not.toMatch(/concept-seed|scripts_path|serve-question|npx /);
    }
  });

  it("is preloaded by the Designer and Visual QA agents", () => {
    expect(ROLE_SKILLS.designer).toEqual(["design-craft"]);
    expect(ROLE_SKILLS.visual_qa).toEqual(["design-craft"]);
    expect(claudeFront("vtc-designer").skills).toEqual(["vtc:design-craft"]);
    expect(claudeFront("vtc-visual-qa").skills).toEqual(["vtc:design-craft"]);
    expect(emitted("codex", `skills/design-craft/SKILL.md`)).not.toContain(CLAUDE_SKILL_DIR);
  });

  it("carries the craft floor: its checks and its refusals", () => {
    const floor = oneLine(reference("craft-floor"));
    for (const check of [
      "4.5:1",
      "65–75ch",
      "6rem",
      "-0.04em",
      "selection",
      "caret",
      "scrollbar",
    ]) {
      expect(floor, check).toContain(check);
    }
    for (const refusal of [
      "Gradient text",
      "nested cards",
      "kicker or eyebrow",
      "border-left",
      "hard offset shadow",
      "Glass and blur",
    ]) {
      expect(floor.toLowerCase(), refusal).toContain(refusal.toLowerCase());
    }
  });

  it("carries new-work steps 1–5 with the engine's roll in place of the upstream one", () => {
    const steps = reference("new-work");
    for (const n of [1, 2, 3, 4, 5])
      expect(steps, String(n)).toMatch(new RegExp(`^${String(n)}\\. `, "m"));
    const text = oneLine(steps);
    for (const phrase of [
      "predictable opposite",
      "seven",
      "three material families",
      "design constraints",
      "category standard",
      "Verbalized sampling",
    ]) {
      expect(text.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
  });

  it("carries the per-screen Direction contract's six blocks", () => {
    const contract = reference("direction-contract");
    for (const block of DIRECTION_BLOCKS)
      expect(contract, block).toMatch(new RegExp(`\\*\\*${block}\\*\\*`));
  });

  it("carries the four screen modes", () => {
    const modes = reference("modes");
    for (const mode of MODES) expect(modes, mode).toMatch(new RegExp(`\\*\\*${mode}\\*\\*`));
  });

  it("carries the font blocklist in the core, so both roles see it", () => {
    for (const face of BLOCKLIST) expect(skill(), face).toContain(face);
  });
});

describe("the Designer and Visual QA follow the fork (spec §9.1; D-bt, reading 174)", () => {
  const designer = (): string => oneLine(claudeBody("vtc-designer"));
  const visual = (): string => oneLine(claudeBody("vtc-visual-qa"));

  it("bumps both roles MAJOR for the locked-core edits (D-bm)", () => {
    expect(role("designer")?.version).toBe("3.0.0");
    expect(role("visual_qa")?.version).toBe("2.0.0");
  });

  it("names the upstream in each role.yaml's fork comment", () => {
    for (const id of ["designer", "visual_qa"]) {
      expect(source(`roles/${id}/role.yaml`), id).toMatch(
        /^# Also forked from pbakaus\/impeccable \(Apache-2\.0, see roles\/NOTICE\) at 2f98774:/m,
      );
    }
  });

  it("has the Designer write a Direction contract per direction, for the key screen", () => {
    for (const block of DIRECTION_BLOCKS) expect(designer(), block).toContain(`\`${block}\``);
    expect(designer()).toContain(
      `\`${String(PROTOCOL_VARS.design_contracts_dir)}/<screen id>.md\``,
    );
    expect(designer()).toMatch(/as a `screens` artifact/);
  });

  it("has the Designer choose a mode per screen, read the craft floor and avoid the blocklist", () => {
    for (const mode of MODES) expect(designer(), mode).toContain(mode);
    expect(designer()).toMatch(/craft floor/);
    expect(designer()).toMatch(/font blocklist/);
    expect(designer()).toMatch(/new-work steps 1–5/);
  });

  it("delivers G2_DIRECTIONS directions on a new-repo UI, and knows the engine enforces it", () => {
    expect(designer()).toContain(
      `${String(G2_DIRECTIONS.min)} to ${String(G2_DIRECTIONS.max)} directions`,
    );
    expect(designer()).toMatch(/re-dispatches you once/);
    expect(designer()).toMatch(/blocking notice/);
  });

  it("has Visual QA judge against the Direction contract, the craft floor and the blocklist", () => {
    expect(visual()).toMatch(/Direction contract/);
    for (const block of ["THESIS", "OWN-WORLD", "FIRST VIEWPORT"]) {
      expect(visual(), block).toContain(`\`${block}\``);
    }
    expect(visual()).toMatch(/craft floor/);
    expect(visual()).toMatch(/font blocklist/);
    for (const mode of MODES) expect(visual(), mode).toContain(mode);
  });
});

describe("the impeccable notice ships in both plugins (Apache-2.0 sections 4(a)–4(d))", () => {
  it("names the upstream, its commit, the derived files and carries the licence text", () => {
    const notice = source("roles/NOTICE");
    expect(notice).toContain("https://github.com/pbakaus/impeccable");
    expect(notice).toContain(IMPECCABLE_COMMIT);
    expect(notice).toContain("Copyright 2025 Paul Bakaus");
    expect(notice).toContain("skills/design-craft/");
    expect(notice).toContain("Apache License");
    expect(notice).toContain("Version 2.0, January 2004");
    expect(notice).toContain("END OF TERMS AND CONDITIONS");
    for (const host of HOST_IDS) expect(emitted(host, "NOTICE")).toBe(notice);
  });
});
