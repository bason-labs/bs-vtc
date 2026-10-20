/**
 * A headless role gets the method skills its prompt names (spine §5 reading 275): `codex exec`
 * runs with plugins off, so a skill such as `design-craft` that the role's prompt names is not
 * loaded. The engine writes the skill's files under `.vtc/state/skills/` in the owner's checkout
 * and names each in the dispatch prompt; a subagent dispatch, whose host loads plugin skills,
 * is unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentNameFor,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  promptShaFor,
  rolePromptAssetPath,
  sha256Hex,
  type AssetBundle,
  type AssetNamespace,
  type HostId,
  type HostOutcome,
  type LeadAction,
  type RoleResultInput,
} from "@vtc/shared";
import { createPluginCatalog, type CallContext } from "../../src/core/index.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  only,
  SPEC,
  spawns,
  spineFor,
  submitResult,
  threatModel,
  workdir,
  type Harness,
  type HeadlessScript,
  type SpawnAction,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const CODEX: CallContext = { host: "codex" };
const DESIGNER = agentNameFor("designer");
const LOCKED = "You are the VTC Designer. Load `design-craft` before you design a screen.";
const EDITABLE = "Prefer one strong direction over three timid ones.";

const manifest = (host: HostId) =>
  PluginManifestSchema.parse({
    v: 1,
    host,
    plugin: "vtc",
    contracts_version: "5.14.0",
    agents: [
      {
        name: DESIGNER,
        role: "designer",
        mode: null,
        kind: "core",
        discipline: null,
        role_version: "1.0.0",
        file: `agents/${DESIGNER}.md`,
        prompt_sha256: promptShaFor(LOCKED),
        locked_sha256: sha256Hex(LOCKED),
        tier: "top",
        effort: "high",
      },
    ],
    skills: [
      { name: "design-craft", kind: "skill", pack: null, file: "skills/design-craft/SKILL.md" },
      { name: "architect", kind: "skill", pack: null, file: "skills/architect/SKILL.md" },
    ],
  });

const pluginFiles = (host: HostId): Record<string, string> => ({
  [PLUGIN_MANIFEST_ASSET]: JSON.stringify(manifest(host)),
  [rolePromptAssetPath(DESIGNER, "locked")]: LOCKED,
  [rolePromptAssetPath(DESIGNER, "editable")]: EDITABLE,
  "skills/design-craft/SKILL.md": "# Design craft\n",
  "skills/design-craft/references/modes.md": "modes\n",
  "skills/architect/SKILL.md": "# Architect\n",
});

const files: Partial<Record<AssetNamespace, Record<string, string>>> = {
  "plugin:codex": pluginFiles("codex"),
  "plugin:claude-code": pluginFiles("claude-code"),
};
const bundle: AssetBundle = {
  read: (namespace, path) => {
    const text = files[namespace]?.[path];
    return text === undefined ? undefined : new TextEncoder().encode(text);
  },
  list: (namespace) => Object.keys(files[namespace] ?? {}).sort(),
};
const plugins = createPluginCatalog(
  { codex: manifest("codex"), "claude-code": manifest("claude-code") },
  bundle,
);

const done = (output: Partial<RoleResultInput>): HostOutcome => ({
  kind: "done",
  session_ref: null,
  output: { summary: "done", ...output },
  model: "gpt-6.1-sol",
  tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 },
  cost_usd: 0.1,
});

/** Every front-half role, done well: it writes its artifact where it works. */
const frontHalf: HeadlessScript = (request) => {
  const write = (path: string, text: string, type: string, role: string) => {
    writeFile(request.cwd, path, text);
    return done({ role, exit: "done", artifacts: [{ type, path }] });
  };
  switch (request.role) {
    case "repo_cartographer":
      return write(".vtc/research/repo-map/map.md", "# map\n", "repo_map", request.role);
    case "ba":
      return write(".vtc/spec/spec.md", SPEC, "spec", request.role);
    case "designer":
      return write(".vtc/design/screens.yaml", "screens: []\n", "screens", request.role);
    case "security":
      writeFile(request.cwd, ".vtc/architecture/threat-model/model.md", "# Threat model\n");
      return done({
        role: "security",
        mode: "design",
        exit: "done",
        artifacts: [{ type: "threat_model", path: ".vtc/architecture/threat-model/model.md" }],
      });
    default:
      return write(".vtc/architecture/spine.md", spineFor(SPEC), "architecture", request.role);
  }
};

const startRun = (h: Harness, call: CallContext) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: true,
      risk_hints: [],
    },
    call,
  );

const approveG1 = async (h: Harness, actions: readonly LeadAction[], call: CallContext) => {
  const g1 = actions.find((a) => a.type === "approve_gate");
  if (g1?.type !== "approve_gate") throw new Error(`expected G1, got ${JSON.stringify(actions)}`);
  return (
    await h.engine.approve(
      { gates: g1.gates, decision: "approve", frozen: g1.artifacts, waived_facts: [] },
      call,
    )
  ).actions;
};

describe(
  "a headless role gets the method skills its prompt names (reading 275)",
  { timeout: 30_000 },
  () => {
    it("writes a headless Codex Designer's skill to the checkout and names it in the prompt", async () => {
      const h = createHarness({ plugins, codex: { headless: frontHalf } });
      await startRun(h, CODEX);
      let actions: LeadAction[] = [];
      for (let i = 0; i < 6 && !actions.some((a) => a.type === "approve_gate"); i++) {
        actions = (await h.engine.next({}, CODEX)).actions;
        await h.engine.settle();
      }
      await approveG1(h, actions, CODEX);
      for (let i = 0; i < 6 && !h.launched.some((l) => l.request.role === "designer"); i++) {
        await h.engine.next({}, CODEX);
        await h.engine.settle();
      }
      const designer = h.launched.find((l) => l.request.role === "designer");
      expect(designer?.request.prompt).toContain(
        `Skill \`design-craft\`: read ${h.repo}/.vtc/state/skills/design-craft/SKILL.md and the references it names`,
      );
      // only the skills the prompt names
      expect(designer?.request.prompt).not.toContain("Skill `architect`");
      expect(readFileSync(join(h.repo, ".vtc/state/skills/design-craft/SKILL.md"), "utf8")).toBe(
        "# Design craft\n",
      );
      expect(
        readFileSync(join(h.repo, ".vtc/state/skills/design-craft/references/modes.md"), "utf8"),
      ).toBe("modes\n");
      // a role whose prompt names no skill gets no Skill line
      const cartographer = h.launched.find((l) => l.request.role === "repo_cartographer");
      expect(cartographer?.request.prompt).not.toMatch(/^Skill /m);
      await h.release();
    });

    it("a Claude Code subagent dispatch of the same role is unchanged: its host loads the skill", async () => {
      const h = createHarness({ plugins });
      await startRun(h, CLAUDE);
      let actions = (await h.engine.next({}, CLAUDE)).actions;
      const carto = only(actions, "repo_cartographer");
      writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
      actions = (
        await submitResult(h, carto, {
          exit: "done",
          artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
        })
      ).actions;
      const ba = only(actions, "ba");
      writeFile(workdir(ba), ".vtc/spec/spec.md", SPEC);
      actions = (
        await submitResult(h, ba, {
          exit: "done",
          artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
        })
      ).actions;
      actions = await approveG1(h, actions, CLAUDE);
      // DESIGN hands out the Architect and Security first; the Designer once one of them is done
      const seen: SpawnAction[] = [];
      for (let i = 0; i < 4 && !seen.some((a) => a.role === "designer"); i++) {
        seen.push(...spawns(actions));
        const step = spawns(actions).find((a) => a.role !== "designer");
        if (step === undefined) break;
        if (step.role !== "security")
          writeFile(workdir(step), ".vtc/architecture/spine.md", spineFor(SPEC));
        actions =
          step.role === "security"
            ? await threatModel(h, step)
            : (
                await submitResult(h, step, {
                  exit: "done",
                  artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
                })
              ).actions;
      }
      seen.push(...spawns(actions));
      const designer = seen.find((a) => a.role === "designer");
      expect(designer?.prompt).toContain("Read your task pack");
      expect(designer?.prompt).not.toMatch(/^Skill /m);
      expect(seen.every((a) => !/^Skill /m.test(a.prompt))).toBe(true);
      await h.release();
    });
  },
);
