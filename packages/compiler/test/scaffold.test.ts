/**
 * The new-role scaffold (D-cd, spine §5 reading 198): `roles/<id>/role.yaml`, a `prompt.md` with
 * a locked core and an editable section, the compiler wiring and a test stub. An evidence-only
 * proposal is labelled `needs-eval`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_LABELS, PROMPT_MARKERS, splitRolePrompt, type RoleContractInput } from "@vtc/shared";
import {
  compilePlugins,
  readSources,
  roleTestStubPath,
  SCAFFOLD_HEADER,
  scaffoldRole,
  writeScaffold,
  type NewRoleRequest,
} from "../src/index.js";
import { fixtureFiles } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const temps: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-scaffold-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const contract = (over: Partial<RoleContractInput> = {}): RoleContractInput => ({
  id: "release_notes",
  version: "1.0.0",
  kind: "core",
  mission: "Write the release notes of a merged feature from its spec and its diff.",
  inputs: ["spec", "diff"],
  output: { artifacts: [], verdicts: [] },
  exits: ["done", "blocked"],
  reviewer: "engine",
  models: {
    "claude-code": { tier: "low", effort: "medium" },
    codex: { tier: "low", effort: "medium" },
  },
  tools: { profile: "read_only" },
  budget: { context_tokens: 12000 },
  ...over,
});

const request = (over: Partial<NewRoleRequest> = {}): NewRoleRequest => ({
  contract: contract(),
  locked: [
    "# Release notes",
    "Write the notes a user reads first.",
    "## Procedure\n\n1. Read the spec, then the diff.",
    "## Definition of done\n\nEvery user-visible change has one line.",
    "## Example\n\n- Invoices: you can filter by due date.",
  ].join("\n\n"),
  editable: "Lead with what changed for the user, not how.",
  reason: "Escalations asked for release notes on three runs, and no role writes them.",
  evaluation: "replay",
  ...over,
});

const ok = (result: ReturnType<typeof scaffoldRole>) => {
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.scaffold;
};

const fileOf = (scaffold: { files: readonly { path: string; text: string }[] }, path: string) =>
  scaffold.files.find((f) => f.path === path)?.text ?? "";

describe("scaffoldRole", () => {
  it("writes role.yaml, prompt.md and a test stub, and the role compiles", () => {
    const scaffold = ok(scaffoldRole(request(), fixtureFiles()));
    expect(scaffold.files.map((f) => f.path)).toEqual([
      "roles/release_notes/role.yaml",
      "roles/release_notes/prompt.md",
      roleTestStubPath("release_notes"),
    ]);
    expect(scaffold.agents).toEqual(["vtc-release-notes"]);
    const result = compilePlugins([
      ...fixtureFiles(),
      ...scaffold.files.filter((f) => f.path.startsWith("roles/")),
    ]);
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (!result.ok) return;
    for (const host of ["claude-code", "codex"] as const) {
      const ext = host === "codex" ? "toml" : "md";
      expect(result.output.targets[host].map((f) => f.path)).toContain(
        `agents/vtc-release-notes.${ext}`,
      );
    }
  });

  it("splits the prompt into its locked core and editable section", () => {
    const scaffold = ok(scaffoldRole(request(), fixtureFiles()));
    const prompt = fileOf(scaffold, "roles/release_notes/prompt.md");
    expect(prompt.startsWith(PROMPT_MARKERS.locked)).toBe(true);
    expect(splitRolePrompt(prompt)).toEqual({
      ok: true,
      locked: request().locked,
      editable: request().editable,
    });
  });

  it("says in role.yaml that the scaffold wrote it, and why", () => {
    const yaml = fileOf(
      ok(scaffoldRole(request(), fixtureFiles())),
      "roles/release_notes/role.yaml",
    );
    expect(yaml.split("\n")[0]).toBe(SCAFFOLD_HEADER);
    expect(yaml).toMatch(/^# Escalations asked for release notes on three runs/m);
  });

  it("labels an evidence-only proposal needs-eval, and a replayable one not", () => {
    expect(ok(scaffoldRole(request(), fixtureFiles())).labels).toEqual([]);
    const evidence = ok(scaffoldRole(request({ evaluation: "evidence_only" }), fixtureFiles()));
    expect(evidence.labels).toEqual([AUTO_LABELS.needsEval]);
    expect(fileOf(evidence, roleTestStubPath("release_notes"))).toContain(AUTO_LABELS.needsEval);
  });

  it("scaffolds a specialist engineer profile for a discipline no profile covers", () => {
    const scaffold = ok(
      scaffoldRole(
        request({
          contract: contract({
            id: "engineer_backend",
            kind: "engineer_profile",
            discipline: "backend",
            mission: "Implement one backend task.",
            inputs: ["task", "spec"],
            exits: ["built", "spec_conflict", "blocked", "out_of_scope_fault"],
            reviewer: "qa",
            tools: { profile: "code_sandboxed" },
          }),
        }),
        fixtureFiles(),
      ),
    );
    expect(scaffold.agents).toEqual(["vtc-engineer-backend"]);
  });

  it("refuses what it cannot scaffold", () => {
    const refused = (over: Partial<NewRoleRequest>): readonly string[] => {
      const result = scaffoldRole(request(over), fixtureFiles());
      return result.ok ? [] : result.errors;
    };
    expect(refused({ contract: contract({ id: "qa" }) })).toContain("roles/qa already exists");
    expect(refused({ contract: contract({ version: "2.0.0" }) })).toContain(
      "a new role starts at version 1.0.0",
    );
    expect(refused({ contract: contract({ kind: "lens" }) }).join("\n")).toMatch(/lens/);
    expect(refused({ contract: contract({ kind: "advisor" }) }).join("\n")).toMatch(/advisor/);
    expect(
      refused({
        contract: contract({
          id: "engineer_ui",
          kind: "engineer_profile",
          discipline: "frontend",
          tools: { profile: "code_sandboxed" },
        }),
      }).join("\n"),
    ).toMatch(/engineer_frontend/);
    expect(refused({ editable: "Use {{disciplines}}." }).join("\n")).toMatch(/placeholder/);
    expect(refused({ reason: "  " })).toContain("say why VTC proposes the role");
    expect(refused({ locked: "# Release notes\n\nNo sections." })).toEqual([
      "prompt.md: needs a procedure section (a heading ending in 'Procedure') (§5.1)",
      "prompt.md: needs a '## Definition of done' section (§5.1)",
      "prompt.md: needs a '## Example' section (a canonical example) (§5.1)",
    ]);
    expect(refused({ contract: contract({ mission: "" }) }).join("\n")).toMatch(/mission/);
  });

  it("fails on a role the compiler refuses, with the compiler's message", () => {
    const result = scaffoldRole(
      request({ contract: contract({ tools: { profile: "read_only", engine_tools: ["next"] } }) }),
      fixtureFiles(),
    );
    expect(result.ok ? [] : result.errors.join("\n")).toMatch(/only the Lead may call it/);
  });
});

describe("the scaffold's files pass the repo's own checks", () => {
  it("compiles against the repo's real sources", () => {
    const scaffold = ok(scaffoldRole(request(), readSources(ROOT).files));
    expect(scaffold.agents).toEqual(["vtc-release-notes"]);
  });

  it("is prettier-clean with the repo's prettier config", async () => {
    const scaffold = ok(scaffoldRole(request({ evaluation: "evidence_only" }), fixtureFiles()));
    for (const file of scaffold.files) {
      const filepath = join(ROOT, file.path);
      const options = (await prettier.resolveConfig(filepath)) ?? {};
      expect(await prettier.format(file.text, { ...options, filepath }), file.path).toBe(file.text);
    }
  });
});

describe("writeScaffold", () => {
  const plantedRoot = (): string => {
    const root = temp();
    for (const file of fixtureFiles()) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.text);
    }
    return root;
  };

  it("writes every file, and the result compiles from disk", () => {
    const root = plantedRoot();
    const scaffold = ok(scaffoldRole(request(), readSources(root).files));
    expect(writeScaffold(root, scaffold)).toEqual(scaffold.files.map((f) => f.path));
    for (const file of scaffold.files) {
      expect(readFileSync(join(root, file.path), "utf8")).toBe(file.text);
    }
    const result = compilePlugins(readSources(root).files);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("never overwrites, and writes nothing when one file exists", () => {
    const root = plantedRoot();
    const scaffold = ok(scaffoldRole(request(), readSources(root).files));
    const stub = join(root, roleTestStubPath("release_notes"));
    mkdirSync(dirname(stub), { recursive: true });
    writeFileSync(stub, "keep me");
    expect(() => writeScaffold(root, scaffold)).toThrow(/exists/);
    expect(readFileSync(stub, "utf8")).toBe("keep me");
    expect(existsSync(join(root, "roles/release_notes/role.yaml"))).toBe(false);
  });

  it("refuses to write through a symbolic link", () => {
    const root = plantedRoot();
    const scaffold = ok(scaffoldRole(request(), readSources(root).files));
    const outside = temp();
    symlinkSync(outside, join(root, "roles", "release_notes"));
    expect(() => writeScaffold(root, scaffold)).toThrow(/symbolic link|real directory/);
    expect(existsSync(join(outside, "role.yaml"))).toBe(false);
  });
});
