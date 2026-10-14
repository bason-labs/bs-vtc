/**
 * The new-role scaffold (D-cd, H-7; spine §5 reading 198). When Lookback proposes a new role or
 * specialist profile, VTC (running on its own bs-vtc checkout) builds it with this API:
 *
 * - `roles/<id>/role.yaml`: the contract, opened by {@link SCAFFOLD_HEADER} and the reason VTC
 *   proposes the role, which the repo's attribution test accepts as "written for VTC";
 * - `roles/<id>/prompt.md`: the locked core, then the editable section Lookback may revise;
 * - the compiler wiring: the compiler picks up every `roles/<id>/` by itself, so the scaffold
 *   proves the wiring instead of editing a list: it compiles the role against the given sources
 *   and returns the compiler's own errors when the role does not compile on both hosts;
 * - a test stub at {@link roleTestStubPath}, which compiles the repo and checks the role's agents.
 *
 * A role is replayed where a replay can compare it (`evaluation: "replay"`); otherwise the PR
 * carries evidence only and the `needs-eval` label (`AUTO_LABELS.needsEval`), which the scaffold
 * returns in `labels` and writes into the test stub as a todo.
 *
 * Only `core` roles and `engineer_profile` specialists are scaffolded: a lens reviewer belongs to
 * a park-the-task risk rule and an advisor answers the human, so both stay hand-made.
 */
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  AUTO_LABELS,
  editableSectionErrors,
  PROMPT_MARKERS,
  RoleContractSchema,
  type RoleContractInput,
  type RoleKind,
} from "@vtc/shared";
import { compiledAgentNames } from "./checks.js";
import { compilePlugins } from "./compile.js";
import { assertRealDirectoryPath } from "./io.js";
import { loadRoles } from "./role-source.js";
import type { SourceFile } from "./types.js";

/** The first line of a scaffolded `role.yaml`. */
export const SCAFFOLD_HEADER = "# Written for VTC by the new-role scaffold (D-cd).";

/** The role kinds the scaffold builds. */
export const SCAFFOLD_KINDS: readonly RoleKind[] = ["core", "engineer_profile"];

/** A new role starts here; a later locked-core edit is MAJOR (D-bm). */
export const SCAFFOLD_VERSION = "1.0.0";

/** Where the scaffold puts the role's test stub, relative to the repo root. */
export const roleTestStubPath = (id: string): string =>
  `packages/compiler/test/roles/${id}.test.ts`;

export interface NewRoleRequest {
  /** The contract exactly as `role.yaml` holds it (`RoleContractSchema` input). */
  readonly contract: RoleContractInput;
  /** The locked core: human-only once it lands. */
  readonly locked: string;
  /** The editable section: the part Lookback may propose changes to. */
  readonly editable: string;
  /** Why VTC proposes the role (the attribution or escalations behind it), one paragraph. */
  readonly reason: string;
  /** `replay` when a Lookback replay can compare the role; else the PR is `needs-eval`. */
  readonly evaluation: "replay" | "evidence_only";
}

export interface RoleScaffold {
  readonly role: string;
  /** `role.yaml`, `prompt.md` and the test stub, by path relative to the repo root. */
  readonly files: readonly SourceFile[];
  /** The agents the role compiles to (`agentNameFor`). */
  readonly agents: readonly string[];
  /** Labels the automatic PR carries beyond `vtc:auto` and its kind label. */
  readonly labels: readonly string[];
}

export type ScaffoldResult =
  | { readonly ok: true; readonly scaffold: RoleScaffold }
  | { readonly ok: false; readonly errors: readonly string[] };

const MAX_REASON = 400;

/**
 * The §5.1 parts a role prompt brings itself (the contract, its exits and the result protocol
 * are generated): the repo's prompt test requires each in every run agent, so a scaffold without
 * one would land a failing PR.
 */
export const SCAFFOLD_PROMPT_PARTS: readonly (readonly [string, RegExp])[] = [
  ["a procedure section (a heading ending in 'Procedure')", /^#{2,3} .*[Pp]rocedure$/m],
  ["a '## Definition of done' section", /^#{2,3} Definition of done$/m],
  ["a '## Example' section (a canonical example)", /^#{2,3} Example$/m],
];

/** One paragraph, wrapped into `# ` comment lines of at most 100 characters. */
const commentLines = (text: string): string[] => {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(" ")) {
    if (line.length + 1 + word.length > 100 && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line = `${line} ${word}`;
  }
  return [...lines, line];
};

const roleYaml = (contract: RoleContractInput, reason: string): string =>
  [SCAFFOLD_HEADER, ...commentLines(reason), stringifyYaml(contract, { lineWidth: 0 })].join("\n");

const promptMd = (locked: string, editable: string): string =>
  `${PROMPT_MARKERS.locked}\n\n${locked.trim()}\n\n${PROMPT_MARKERS.editable}\n\n${editable.trim()}\n`;

const testStub = (
  id: string,
  agents: readonly string[],
  reason: string,
  needsEval: boolean,
): string => {
  const evaluation = needsEval
    ? ` * Evaluation: ${AUTO_LABELS.needsEval}. No replay could compare this role, so its pull request
 * carries evidence only.`
    : " * Evaluation: a Lookback replay compares this role.";
  const paths = agents.flatMap((agent) => [`agents/${agent}.md`, `agents/${agent}.toml`]);
  return `/**
 * roles/${id}, written by the new-role scaffold (D-cd, spine §5 reading 198).
 * Why: ${reason.replaceAll("*/", "* /")}
${evaluation}
 * Add the role's own checks here before its pull request leaves draft.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compilePlugins, readSources } from "../../src/index.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const compiled = compilePlugins(readSources(ROOT).files);

describe("roles/${id} (scaffolded)", () => {
  it("compiles into its agents on both hosts", () => {
    expect(compiled.ok ? [] : compiled.errors).toEqual([]);
    const emitted = compiled.ok
      ? [...compiled.output.targets["claude-code"], ...compiled.output.targets.codex]
      : [];
    const paths = emitted.map((file) => file.path);
${paths.map((path) => `    expect(paths).toContain(${JSON.stringify(path)});`).join("\n")}
  });
${
  needsEval
    ? `
  it.todo("${AUTO_LABELS.needsEval}: evaluate the role on recorded dispatches once a replay can compare it");
`
    : ""
}});
`;
};

/** Pure: what keeps `request` from being scaffolded against `sources`, before compiling. */
const requestErrors = (
  request: NewRoleRequest,
  sources: readonly SourceFile[],
  roles: readonly { readonly id: string; readonly discipline?: string | undefined }[],
): string[] => {
  const parsed = RoleContractSchema.safeParse(request.contract);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (i) => `role.yaml: ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
  }
  const role = parsed.data;
  const errors: string[] = [];
  if (sources.some((f) => f.path.startsWith(`roles/${role.id}/`))) {
    errors.push(`roles/${role.id} already exists`);
  }
  if (role.version !== SCAFFOLD_VERSION)
    errors.push(`a new role starts at version ${SCAFFOLD_VERSION}`);
  if (!SCAFFOLD_KINDS.includes(role.kind)) {
    errors.push(
      `a ${role.kind} role is not scaffolded: a lens reviewer belongs to a park-the-task risk rule and an advisor answers the human, so both are added by hand`,
    );
  }
  if (role.kind === "engineer_profile") {
    if (role.id !== `engineer_${String(role.discipline)}`) {
      errors.push(
        `an engineer profile's id is engineer_<discipline>: engineer_${String(role.discipline)}`,
      );
    }
    const taken = roles.find((r) => r.discipline === role.discipline && r.id !== role.id);
    if (taken !== undefined) {
      errors.push(`discipline ${String(role.discipline)} already has its profile ${taken.id}`);
    }
  }
  if (request.reason.trim() === "") errors.push("say why VTC proposes the role");
  else if (request.reason.length > MAX_REASON) {
    errors.push(`the reason is longer than ${String(MAX_REASON)} characters`);
  }
  if (request.locked.trim() === "") errors.push("prompt.md: the locked core is empty");
  if (request.editable.trim() === "") errors.push("prompt.md: the editable section is empty");
  errors.push(...editableSectionErrors(request.editable.trim()).map((e) => `prompt.md: ${e}`));
  const prompt = `${request.locked}\n${request.editable}`;
  for (const [part, pattern] of SCAFFOLD_PROMPT_PARTS) {
    if (!pattern.test(prompt)) errors.push(`prompt.md: needs ${part} (§5.1)`);
  }
  return errors;
};

/** The roles in `sources` that load, by id and discipline. */
const knownRoles = (
  sources: readonly SourceFile[],
): { readonly id: string; readonly discipline?: string | undefined }[] =>
  loadRoles(sources).roles.map((r) => ({ id: r.role.id, discipline: r.role.discipline }));

/**
 * Builds the scaffold for `request` against the repo's current `sources` (every file under
 * `roles/`, `skills/` and `plugins/`, as `readSources` returns them). Pure: nothing is written.
 */
export const scaffoldRole = (
  request: NewRoleRequest,
  sources: readonly SourceFile[],
): ScaffoldResult => {
  const errors = requestErrors(request, sources, knownRoles(sources));
  if (errors.length > 0) return { ok: false, errors };
  const role = RoleContractSchema.parse(request.contract);
  const reason = request.reason.trim().replace(/\s+/g, " ");
  const roleFiles: SourceFile[] = [
    { path: `roles/${role.id}/role.yaml`, text: roleYaml(request.contract, reason) },
    { path: `roles/${role.id}/prompt.md`, text: promptMd(request.locked, request.editable) },
  ];
  const compiled = compilePlugins([...sources, ...roleFiles]);
  if (!compiled.ok)
    return { ok: false, errors: compiled.errors.map((e) => `${e.path}: ${e.message}`) };
  const agents = compiledAgentNames(role);
  const needsEval = request.evaluation === "evidence_only";
  return {
    ok: true,
    scaffold: {
      role: role.id,
      files: [
        ...roleFiles,
        { path: roleTestStubPath(role.id), text: testStub(role.id, agents, reason, needsEval) },
      ],
      agents,
      labels: needsEval ? [AUTO_LABELS.needsEval] : [],
    },
  };
};

const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Writes a scaffold under `root`. Nothing is overwritten and nothing is written through a
 * symbolic link: every file is checked before the first write, and each is created exclusively.
 * Returns the written paths, relative to `root`.
 */
export const writeScaffold = (root: string, scaffold: RoleScaffold): string[] => {
  for (const file of scaffold.files) {
    assertRealDirectoryPath(root, dirname(file.path));
    let exists = true;
    try {
      lstatSync(join(root, file.path));
    } catch {
      exists = false;
    }
    if (exists) throw new Error(`refusing to overwrite ${file.path}: it exists`);
  }
  for (const file of scaffold.files) {
    mkdirSync(join(root, dirname(file.path)), { recursive: true });
    const fd = openSync(join(root, file.path), NEW_FILE, 0o644);
    try {
      writeSync(fd, file.text);
    } finally {
      closeSync(fd);
    }
  }
  return scaffold.files.map((f) => f.path);
};
