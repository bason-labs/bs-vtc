/**
 * The compile step (§4.4, AD-14, AD-16): neutral sources in `roles/`, `skills/` and `plugins/`
 * → the Claude Code plugin and the Codex plugin, as in-memory file lists. Pure and
 * deterministic; `io.ts` reads the sources and writes `dist/`. Every error is collected, and the
 * step fails on any AD-9 marker in a source or an emitted file.
 */
import { createHash } from "node:crypto";
import {
  CONTRACTS_VERSION,
  DOMAIN_PACKS,
  engineMcpServer,
  findForbiddenInText,
  HOST_IDS,
  type HostId,
  type RoleContract,
} from "@vtc/shared";
import { checkPluginFiles, compiledAgentNames } from "./checks.js";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.js";
import { PLUGIN_NAME, renderClaudeAgent, renderCodexAgent } from "./hosts.js";
import { buildInstructions, type InstructionSources } from "./instructions.js";
import { loadRoles, type LoadedRole } from "./role-source.js";
import type {
  CompileError,
  CompileResult,
  CompiledAgent,
  EmittedFile,
  ManifestAgent,
  ManifestSkill,
  PluginManifest,
  SkillKind,
  SourceFile,
} from "./types.js";

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHARED_FRAGMENTS = new Set(["result-protocol.md", "lens-reviewer.md"]);
const IGNORED = new Set(["roles/README.md", "skills/README.md", "plugins/README.md"]);

interface Skill {
  readonly name: string;
  readonly origin: "skills" | "plugin";
  readonly body: string;
  /** Files of the skill directory, by path relative to it (`SKILL.md`, `references/x.md`). */
  readonly files: readonly EmittedFile[];
}

interface Command {
  readonly name: string;
  readonly source: SourceFile;
  readonly description: string;
  readonly body: string;
}

const KIND_LABEL: Readonly<Record<RoleContract["kind"], string>> = {
  core: "role",
  engineer_profile: "engineer profile",
  lens: "lens reviewer",
  advisor: "advisor",
};

const describeAgent = (role: RoleContract, mode: string | undefined): string =>
  `VTC ${KIND_LABEL[role.kind]} ${role.id}${mode === undefined ? "" : ` (${mode} mode)`}: ${role.mission.trim()} Runs only when the VTC Lead dispatches it for the engine.`;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const skillKind = (skill: Skill): { kind: SkillKind; pack: string | null } => {
  if (skill.origin === "plugin") return { kind: "plugin", pack: null };
  const prefixed = /^(stack|domain|lens)-(.+)$/.exec(skill.name);
  if (prefixed?.[1] === "stack") return { kind: "stack_pack", pack: prefixed[2] ?? null };
  if (prefixed?.[1] === "domain") {
    return { kind: "domain_pack", pack: (prefixed[2] ?? "").replaceAll("-", "_") };
  }
  if (prefixed?.[1] === "lens") return { kind: "lens", pack: prefixed[2] ?? null };
  return { kind: "skill", pack: null };
};

const packList = (skills: readonly Skill[], kind: SkillKind): string => {
  const packs = skills.flatMap((s) => {
    const k = skillKind(s);
    return k.kind === kind && k.pack !== null ? [k.pack] : [];
  });
  return packs.length === 0 ? "none" : packs.join(", ");
};

/** Collects skills from `skills/<name>/` and `plugins/common/skills/<name>/`. */
const collectSkills = (files: readonly SourceFile[], errors: CompileError[]): Skill[] => {
  const groups = new Map<string, { origin: Skill["origin"]; dir: string; files: SourceFile[] }>();
  for (const file of files) {
    const match =
      /^skills\/([^/]+)\/(.+)$/.exec(file.path) ??
      /^plugins\/common\/skills\/([^/]+)\/(.+)$/.exec(file.path);
    if (match?.[1] === undefined) continue;
    const origin = file.path.startsWith("skills/") ? "skills" : "plugin";
    const dir = origin === "skills" ? `skills/${match[1]}` : `plugins/common/skills/${match[1]}`;
    const key = `${origin}:${match[1]}`;
    const group = groups.get(key) ?? { origin, dir, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  const skills: Skill[] = [];
  const seen = new Map<string, string>();
  for (const group of groups.values()) {
    const name = group.dir.slice(group.dir.lastIndexOf("/") + 1);
    const main = group.files.find((f) => f.path === `${group.dir}/SKILL.md`);
    if (main === undefined) {
      errors.push({ path: group.dir, message: "a skill directory needs a SKILL.md" });
      continue;
    }
    const front = parseFrontmatter(main.text);
    if (!front.ok) {
      errors.push({ path: main.path, message: front.error });
      continue;
    }
    const before = errors.length;
    if (!SKILL_NAME.test(name) || name.length > 64) {
      errors.push({ path: group.dir, message: "skill names are lower-case words joined by '-'" });
    }
    if (front.data.name !== name) {
      errors.push({ path: main.path, message: `frontmatter name must be ${name}` });
    }
    const description = front.data.description;
    if (typeof description !== "string" || description.trim() === "") {
      errors.push({ path: main.path, message: "frontmatter needs a description" });
    } else if (description.length > 1024) {
      errors.push({ path: main.path, message: "description is longer than 1024 characters" });
    }
    const other = seen.get(name);
    if (other !== undefined) {
      errors.push({ path: group.dir, message: `skill ${name} is also defined in ${other}` });
    }
    seen.set(name, group.dir);
    const skill: Skill = {
      name,
      origin: group.origin,
      body: front.body,
      files: group.files.map((f) => ({ path: f.path.slice(group.dir.length + 1), text: f.text })),
    };
    const kind = skillKind(skill);
    if (
      kind.kind === "domain_pack" &&
      !(DOMAIN_PACKS as readonly string[]).includes(kind.pack ?? "")
    ) {
      errors.push({
        path: group.dir,
        message: `${String(kind.pack)} is not a domain pack in DOMAIN_PACKS`,
      });
    }
    if (errors.length === before) skills.push(skill);
  }
  return skills.sort((a, b) => (a.name < b.name ? -1 : 1));
};

const collectCommands = (files: readonly SourceFile[], errors: CompileError[]): Command[] => {
  const commands: Command[] = [];
  for (const file of files.filter((f) => f.path.startsWith("plugins/common/commands/"))) {
    const match = /^plugins\/common\/commands\/([a-z0-9-]+)\.md$/.exec(file.path);
    if (match?.[1] === undefined) {
      errors.push({ path: file.path, message: "commands are plugins/common/commands/<name>.md" });
      continue;
    }
    const front = parseFrontmatter(file.text);
    if (!front.ok) {
      errors.push({ path: file.path, message: front.error });
      continue;
    }
    const description = front.data.description;
    if (typeof description !== "string" || description.trim() === "") {
      errors.push({ path: file.path, message: "frontmatter needs a description" });
      continue;
    }
    commands.push({ name: match[1], source: file, description, body: front.body.trim() });
  }
  return commands.sort((a, b) => (a.name < b.name ? -1 : 1));
};

/** Unknown files at fixed places are errors, so nothing is silently left out of a plugin. */
const checkLayout = (files: readonly SourceFile[], errors: CompileError[]): void => {
  for (const file of files) {
    const { path } = file;
    if (IGNORED.has(path) || path === "roles/NOTICE") continue;
    const shared = /^roles\/_shared\/(.+)$/.exec(path);
    if (shared?.[1] !== undefined) {
      if (!SHARED_FRAGMENTS.has(shared[1])) {
        errors.push({ path, message: "unexpected file in roles/_shared" });
      }
      continue;
    }
    const known =
      /^roles\/[^_/][^/]*\/.+$/.test(path) ||
      /^skills\/[^/]+\/.+$/.test(path) ||
      /^plugins\/common\/(skills|commands)\/.+$/.test(path) ||
      /^plugins\/(claude-code|codex)\/.+$/.test(path);
    if (!known) errors.push({ path, message: "unexpected file; see the README of its directory" });
  }
  if (files.some((f) => f.path === "plugins/codex/.mcp.json")) {
    errors.push({
      path: "plugins/codex/.mcp.json",
      message: "the Codex MCP entry is generated from engineMcpServer; do not hand-write it",
    });
  }
};

const mcpJson = (host: HostId): string => {
  const entry = engineMcpServer(host);
  return `${JSON.stringify({ mcpServers: { [entry.name]: { command: entry.command, args: entry.args } } }, null, 2)}\n`;
};

const checkClaudeMcp = (files: readonly SourceFile[], errors: CompileError[]): void => {
  const path = "plugins/claude-code/.mcp.json";
  const file = files.find((f) => f.path === path);
  const expected = JSON.parse(mcpJson("claude-code")) as unknown;
  let actual: unknown;
  try {
    actual = file === undefined ? undefined : (JSON.parse(file.text) as unknown);
  } catch {
    actual = undefined;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const entry = engineMcpServer("claude-code");
    errors.push({
      path,
      message: `must register the engine as ${entry.name}: ${entry.command} ${entry.args.join(" ")}`,
    });
  }
};

const requireFile = (files: readonly SourceFile[], path: string, errors: CompileError[]): void => {
  if (!files.some((f) => f.path === path))
    errors.push({ path, message: "required file is missing" });
};

const compileAgents = (
  roles: readonly LoadedRole[],
  host: HostId,
  sources: InstructionSources,
  errors: CompileError[],
): CompiledAgent[] => {
  const agents: CompiledAgent[] = [];
  for (const loaded of roles) {
    const { role } = loaded;
    const modes = role.modes === undefined ? [undefined] : Object.keys(role.modes);
    const names = compiledAgentNames(role);
    modes.forEach((mode, index) => {
      const built = buildInstructions(loaded, mode, host, sources);
      if (!built.ok) {
        for (const message of built.errors) {
          if (!errors.some((e) => e.path === `roles/${loaded.dir}` && e.message === message)) {
            errors.push({ path: `roles/${loaded.dir}`, message });
          }
        }
        return;
      }
      agents.push({
        name: names[index] ?? "",
        role: role.id,
        mode,
        kind: role.kind,
        discipline: role.discipline,
        roleVersion: role.version,
        description: describeAgent(role, mode),
        tools: built.contract.tools,
        model: built.contract.models[host],
        instructions: built.text,
      });
    });
  }
  return agents.sort((a, b) => (a.name < b.name ? -1 : 1));
};

const manifestAgent = (agent: CompiledAgent, file: string): ManifestAgent => ({
  name: agent.name,
  role: agent.role,
  mode: agent.mode ?? null,
  kind: agent.kind,
  discipline: agent.discipline ?? null,
  role_version: agent.roleVersion,
  file,
  prompt_sha256: sha256(agent.instructions),
  tier: agent.model.tier,
  effort: agent.model.effort,
});

const verbatim = (files: readonly SourceFile[], prefix: string): EmittedFile[] =>
  files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ path: f.path.slice(prefix.length), text: f.text }));

const skillFiles = (skills: readonly Skill[]): EmittedFile[] =>
  skills.flatMap((s) => s.files.map((f) => ({ path: `skills/${s.name}/${f.path}`, text: f.text })));

const codexCommandSkill = (command: Command): string =>
  renderFrontmatter(
    { name: command.name, description: command.description.trim() },
    `${command.body.replaceAll("$ARGUMENTS", "(the text the user typed after the command)")}\n`,
  );

const manifestFile = (manifest: PluginManifest): EmittedFile => ({
  path: "vtc-manifest.json",
  text: `${JSON.stringify(manifest, null, 2)}\n`,
});

const sortFiles = (files: EmittedFile[]): EmittedFile[] =>
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** Compiles the sources (every file under `roles/`, `skills/` and `plugins/`). */
export const compilePlugins = (files: readonly SourceFile[]): CompileResult => {
  const errors: CompileError[] = [];
  for (const file of files) {
    for (const hit of findForbiddenInText(file.text)) {
      errors.push({
        path: file.path,
        message: `line ${String(hit.line)}: AD-9 marker ${hit.marker}`,
      });
    }
  }
  checkLayout(files, errors);
  checkClaudeMcp(files, errors);
  requireFile(files, "plugins/claude-code/.claude-plugin/plugin.json", errors);
  requireFile(files, "plugins/codex/plugin.json", errors);
  requireFile(files, "roles/NOTICE", errors);
  requireFile(files, "roles/_shared/result-protocol.md", errors);

  const loaded = loadRoles(files);
  if (!loaded.ok) errors.push(...loaded.errors);
  const skills = collectSkills(files, errors);
  const commands = collectCommands(files, errors);
  for (const command of commands) {
    if (skills.some((s) => s.name === command.name)) {
      errors.push({
        path: command.source.path,
        message: `command ${command.name} collides with a skill of that name`,
      });
    }
  }

  const text = (path: string): string | undefined => files.find((f) => f.path === path)?.text;
  const sources: InstructionSources = {
    protocol: text("roles/_shared/result-protocol.md") ?? "",
    lensReviewer: text("roles/_shared/lens-reviewer.md"),
    engineer: loaded.roles.find((r) => r.role.id === "engineer"),
    skillBodies: new Map(skills.map((s) => [s.name, s.body])),
    vars: {
      stack_packs: packList(skills, "stack_pack"),
      domain_packs: packList(skills, "domain_pack"),
      lenses: packList(skills, "lens"),
    },
  };
  const notice = text("roles/NOTICE") ?? "";
  const targets = {} as Record<HostId, EmittedFile[]>;

  for (const host of HOST_IDS) {
    const agents = compileAgents(loaded.roles, host, sources, errors);
    const ext = host === "codex" ? "toml" : "md";
    const render = host === "codex" ? renderCodexAgent : renderClaudeAgent;
    const emitted: EmittedFile[] = [
      { path: "NOTICE", text: notice },
      ...skillFiles(skills),
      ...agents.map((a) => ({ path: `agents/${a.name}.${ext}`, text: render(a) })),
    ];
    const manifestSkills: ManifestSkill[] = skills.map((s) => ({
      name: s.name,
      ...skillKind(s),
      file: `skills/${s.name}/SKILL.md`,
    }));
    if (host === "claude-code") {
      emitted.push(...verbatim(files, "plugins/claude-code/"));
      for (const c of commands) {
        emitted.push({ path: `commands/${c.name}.md`, text: c.source.text });
        manifestSkills.push({
          name: c.name,
          kind: "command",
          pack: null,
          file: `commands/${c.name}.md`,
        });
      }
    } else {
      emitted.push(...verbatim(files, "plugins/codex/"), {
        path: ".mcp.json",
        text: mcpJson(host),
      });
      for (const c of commands) {
        emitted.push({ path: `skills/${c.name}/SKILL.md`, text: codexCommandSkill(c) });
        manifestSkills.push({
          name: c.name,
          kind: "command",
          pack: null,
          file: `skills/${c.name}/SKILL.md`,
        });
      }
    }
    manifestSkills.sort((a, b) => (a.name < b.name ? -1 : 1));
    emitted.push(
      manifestFile({
        v: 1,
        host,
        plugin: PLUGIN_NAME,
        contracts_version: CONTRACTS_VERSION,
        agents: agents.map((a) => manifestAgent(a, `agents/${a.name}.${ext}`)),
        skills: manifestSkills,
      }),
    );
    targets[host] = sortFiles(emitted);
    for (const v of checkPluginFiles(targets[host])) {
      errors.push({
        path: `${host}:${v.path}`,
        message: `line ${String(v.line)}: AD-9 marker ${v.marker} in emitted file`,
      });
    }
  }

  const unique = errors.filter(
    (e, i) => errors.findIndex((o) => o.path === e.path && o.message === e.message) === i,
  );
  return unique.length > 0 ? { ok: false, errors: unique } : { ok: true, output: { targets } };
};
