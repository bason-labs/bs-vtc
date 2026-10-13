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
  ENGINE_MCP_TOOLS,
  engineMcpServer,
  findForbiddenInText,
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

/**
 * The prompt content SHA of a compiled agent (§13, `role.dispatched.prompt_sha`): lower-case hex
 * SHA-256 of the UTF-8 bytes of its instructions, exactly as emitted: the body after the
 * frontmatter of a Claude Code agent file, equal to `developer_instructions` of the Codex agent.
 * Host frontmatter and TOML keys are not hashed.
 */
export const promptSha256 = (instructions: string): string =>
  createHash("sha256").update(instructions, "utf8").digest("hex");

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

/** Hand-written files each host directory may hold (AD-16 rule 1); anything else is an error. */
export const HOST_PLUGIN_FILES: Readonly<Record<HostId, readonly string[]>> = {
  "claude-code": [".claude-plugin/plugin.json", ".mcp.json"],
  codex: ["plugin.json"],
};

/** A clean relative POSIX path: no empty, `.` or `..` segment, no backslash, not absolute. */
const isCleanPath = (path: string): boolean =>
  !path.includes("\\") && path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

/** Unknown files at fixed places are errors, so nothing is silently left out of a plugin. */
const checkLayout = (files: readonly SourceFile[], errors: CompileError[]): void => {
  for (const file of files) {
    const { path } = file;
    if (!isCleanPath(path)) {
      errors.push({ path, message: "source paths are relative POSIX paths without . or .." });
      continue;
    }
    if (IGNORED.has(path) || path === "roles/NOTICE") continue;
    const shared = /^roles\/_shared\/(.+)$/.exec(path);
    if (shared?.[1] !== undefined) {
      if (!SHARED_FRAGMENTS.has(shared[1])) {
        errors.push({ path, message: "unexpected file in roles/_shared" });
      }
      continue;
    }
    const host = /^plugins\/(claude-code|codex)\/(.+)$/.exec(path);
    if (host?.[1] !== undefined && host[2] !== undefined) {
      if (path === "plugins/codex/.mcp.json") {
        errors.push({
          path,
          message: "the Codex MCP entry is generated from engineMcpServer; do not hand-write it",
        });
      } else if (host[2].startsWith("hooks/")) {
        errors.push({
          path,
          message:
            "hooks need a cli contract for the command they run first (AD-8 rule 3: an extra layer only)",
        });
      } else if (!HOST_PLUGIN_FILES[host[1] as HostId].includes(host[2])) {
        errors.push({ path, message: "unexpected host plugin file; see plugins/README.md" });
      }
      continue;
    }
    const known =
      /^roles\/[^_/][^/]*\/.+$/.test(path) ||
      /^skills\/[^/]+\/.+$/.test(path) ||
      /^plugins\/common\/(skills|commands)\/.+$/.test(path);
    if (!known) errors.push({ path, message: "unexpected file; see the README of its directory" });
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

/**
 * Role-facing engine MCP tools in the frozen contract. None yet: the frozen surface
 * (`ENGINE_MCP_TOOLS`) holds the Lead's tools only, and AD-4 rule 3 adds role-facing ones (repo
 * map, research fetchers, fact lookups) as a MINOR change to @vtc/shared. Until then a role that
 * names an engine tool does not compile, so no agent is built against a tool nobody serves.
 */
export const ROLE_FACING_ENGINE_TOOLS: readonly string[] = [];

const LEAD_TOOLS: readonly string[] = ENGINE_MCP_TOOLS.map((tool) => tool.name);

/** Errors for engine tools a role may not call (unknown, or one of the Lead's run-driving tools). */
export const engineToolErrors = (tools: readonly string[]): string[] =>
  tools.flatMap((tool) => {
    if (LEAD_TOOLS.includes(tool)) {
      return [`engine tool ${tool} drives the run; only the Lead may call it`];
    }
    if (!ROLE_FACING_ENGINE_TOOLS.includes(tool)) {
      return [
        `engine tool ${tool} is not a role-facing tool in @vtc/shared (AD-4 rule 3: added as a MINOR contract change)`,
      ];
    }
    return [];
  });

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
      const messages = built.ok
        ? engineToolErrors(built.contract.tools.engine_tools)
        : [...built.errors];
      if (!built.ok || messages.length > 0) {
        for (const message of messages) {
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
  prompt_sha256: promptSha256(agent.instructions),
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

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

interface TargetInput {
  readonly files: readonly SourceFile[];
  readonly roles: readonly LoadedRole[];
  readonly skills: readonly Skill[];
  readonly commands: readonly Command[];
  readonly sources: InstructionSources;
  readonly notice: string;
}

/**
 * One host's plugin tree: NOTICE, skills, agents, the host's hand-written files, commands (a
 * Claude Code command, a Codex skill), the MCP entry (hand-written and checked for Claude Code,
 * generated for Codex) and `vtc-manifest.json`. A path emitted twice is an error, so a
 * hand-written file can never silently shadow a generated one.
 */
const emitTarget = (host: HostId, input: TargetInput, errors: CompileError[]): EmittedFile[] => {
  const agents = compileAgents(input.roles, host, input.sources, errors);
  const ext = host === "codex" ? "toml" : "md";
  const render = host === "codex" ? renderCodexAgent : renderClaudeAgent;
  const emitted: EmittedFile[] = [
    { path: "NOTICE", text: input.notice },
    ...skillFiles(input.skills),
    ...agents.map((a) => ({ path: `agents/${a.name}.${ext}`, text: render(a) })),
    ...verbatim(input.files, `plugins/${host}/`),
  ];
  const skills: ManifestSkill[] = input.skills.map((s) => ({
    name: s.name,
    ...skillKind(s),
    file: `skills/${s.name}/SKILL.md`,
  }));
  for (const c of input.commands) {
    const file = host === "codex" ? `skills/${c.name}/SKILL.md` : `commands/${c.name}.md`;
    emitted.push({ path: file, text: host === "codex" ? codexCommandSkill(c) : c.source.text });
    skills.push({ name: c.name, kind: "command", pack: null, file });
  }
  if (host === "codex") emitted.push({ path: ".mcp.json", text: mcpJson(host) });
  emitted.push(
    manifestFile({
      v: 1,
      host,
      plugin: PLUGIN_NAME,
      contracts_version: CONTRACTS_VERSION,
      agents: agents.map((a) => manifestAgent(a, `agents/${a.name}.${ext}`)),
      skills: skills.sort((a, b) => (a.name < b.name ? -1 : 1)),
    }),
  );
  const sorted = emitted.sort(byPath);
  errors.push(...checkEmitted(host, sorted));
  return sorted;
};

/**
 * The gate on one host's emitted tree: no path emitted twice, and no AD-9 marker in any emitted
 * file (AD-16 rule 2). `files` must be sorted by path.
 */
export const checkEmitted = (host: HostId, files: readonly EmittedFile[]): CompileError[] => {
  const errors: CompileError[] = [];
  files.forEach((file, index) => {
    if (files[index + 1]?.path === file.path) {
      errors.push({ path: `${host}:${file.path}`, message: "emitted twice" });
    }
  });
  for (const v of checkPluginFiles(files)) {
    errors.push({
      path: `${host}:${v.path}`,
      message: `line ${String(v.line)}: AD-9 marker ${v.marker} in emitted file`,
    });
  }
  return errors;
};

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
  const input: TargetInput = {
    files,
    roles: loaded.roles,
    skills,
    commands,
    sources,
    notice: text("roles/NOTICE") ?? "",
  };
  const targets = {
    "claude-code": emitTarget("claude-code", input, errors),
    codex: emitTarget("codex", input, errors),
  };

  const unique = errors.filter(
    (e, i) => errors.findIndex((o) => o.path === e.path && o.message === e.message) === i,
  );
  return unique.length > 0 ? { ok: false, errors: unique } : { ok: true, output: { targets } };
};
