import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAdapter } from "../../src/index.js";
import { upsertMcpServerTable } from "../../src/codex/install.js";
import { writeFixturePlugin } from "../support/plugin-fixture.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const setup = () => {
  const home = temp("vtc-home-");
  const projectRoot = temp("vtc-project-");
  const pluginDir = temp("vtc-plugin-");
  writeFixturePlugin("codex", pluginDir);
  return { home, projectRoot, pluginDir };
};

const TABLE = [
  "# Managed by `vtc install`: the vtc engine bridge (rewritten on install).",
  "[mcp_servers.vtc]",
  'command = "vtc"',
  'args = ["engine", "--mcp", "--host", "codex"]',
  "",
].join("\n");

describe("Codex install (AD-6 rule 5, AD-16 rules 3–4)", () => {
  it("project scope: copies the compiled agents to .codex/agents and registers the engine", async () => {
    const env = setup();
    const result = await createCodexAdapter().install({ ...env, scope: "project" });
    const agents = join(env.projectRoot, ".codex", "agents");
    const config = join(env.projectRoot, ".codex", "config.toml");
    expect(readdirSync(agents).sort()).toEqual(["vtc-engineer.toml", "vtc-qa-judge.toml"]);
    expect(readFileSync(join(agents, "vtc-qa-judge.toml"), "utf8")).toBe(
      readFileSync(join(env.pluginDir, "agents", "vtc-qa-judge.toml"), "utf8"),
    );
    expect(readFileSync(config, "utf8")).toBe(TABLE);
    const skill = join(env.projectRoot, ".agents", "skills", "vtc-vtc", "SKILL.md");
    expect([...result.written].sort()).toEqual(
      [join(agents, "vtc-engineer.toml"), join(agents, "vtc-qa-judge.toml"), config, skill].sort(),
    );
    expect(existsSync(join(env.home, ".codex"))).toBe(false);
    expect(result.notes.join(" ")).toContain("trust this project");
  });

  it("user scope writes under the injected home only", async () => {
    const env = setup();
    const result = await createCodexAdapter().install({ ...env, scope: "user" });
    for (const path of result.written)
      expect(
        path.startsWith(join(env.home, ".codex")) || path.startsWith(join(env.home, ".agents")),
      ).toBe(true);
    expect(existsSync(join(env.projectRoot, ".codex"))).toBe(false);
  });

  it("places the plugin's skills where Codex loads skills, and keeps the user's own (F7)", async () => {
    const env = setup();
    const skills = join(env.projectRoot, ".agents", "skills");
    mkdirSync(join(skills, "mine"), { recursive: true });
    writeFileSync(join(skills, "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\n");
    mkdirSync(join(skills, "vtc-gone"), { recursive: true });
    writeFileSync(join(skills, "vtc-gone", ".vtc-generated"), "");
    const result = await createCodexAdapter().install({ ...env, scope: "project" });
    // learn.chatgpt.com/docs/build-skills: $REPO_ROOT/.agents/skills/<skill>/SKILL.md
    expect(readFileSync(join(skills, "vtc-vtc", "SKILL.md"), "utf8")).toBe(
      readFileSync(join(env.pluginDir, "skills", "vtc", "SKILL.md"), "utf8"),
    );
    expect(existsSync(join(skills, "vtc-vtc", ".vtc-generated"))).toBe(true);
    expect(existsSync(join(skills, "mine", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skills, "vtc-gone"))).toBe(false);
    // D-bn (spine §5 reading 168): the plugin is to be registered, hooks included; until this
    // install does it, the notes say so and the skills stay where Codex loads skills
    const registration = result.notes.find((note) => note.includes("not registered with Codex"));
    expect(registration).toMatch(/not registered with Codex yet/);
    expect(registration).toMatch(/hooks/);
    expect(registration).toMatch(/desktop app/);
    expect(registration).toContain(skills);
    // the note a user reads carries no internal decision id
    expect(result.notes.join(" ")).not.toMatch(/\bD-[a-z]{1,3}\b/u);
    // H-1 (spine §5 reading 99, replacing F7's "no roles in v1"): the engine runs a Codex Lead's
    // roles as headless Codex runs; in-session Codex roles stay refused (reading 82)
    const notes = result.notes.join(" ");
    expect(notes).not.toMatch(/can run no roles/i);
    expect(notes).toMatch(
      /a Codex Lead's roles run as headless Codex runs the engine starts itself/i,
    );
    expect(notes).toMatch(/never inside the Codex session/i);
    // the remedy when a headless launch is impossible: vtc doctor, or a Claude Lead
    expect(notes).toContain("vtc doctor");
    expect(notes).toContain("vtc install --host claude-code");
  });

  it("keeps the user's config and replaces only its own table, idempotently", async () => {
    const env = setup();
    const config = join(env.home, ".codex", "config.toml");
    mkdirSync(join(env.home, ".codex"), { recursive: true });
    const mine = [
      'model = "my-model"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[mcp_servers.vtc]",
      'command = "old-vtc"',
      "",
      "[mcp_servers.vtc.env]",
      'X = "1"',
      "",
      "[profiles.fast]",
      'model = "m"',
      "",
    ].join("\n");
    writeFileSync(config, mine);
    const adapter = createCodexAdapter();
    await adapter.install({ ...env, scope: "user" });
    const once = readFileSync(config, "utf8");
    expect(once).toBe(
      [
        'model = "my-model"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
        "[profiles.fast]",
        'model = "m"',
        "",
        TABLE,
      ].join("\n"),
    );
    await adapter.install({ ...env, scope: "user" });
    expect(readFileSync(config, "utf8")).toBe(once);
  });

  it("removes VTC agents a newer plugin dropped, never the user's own agents", async () => {
    const env = setup();
    const agents = join(env.projectRoot, ".codex", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, "vtc-old-role.toml"),
      "# Generated by @vtc/compiler from roles/old\n",
    );
    writeFileSync(join(agents, "vtc-mine.toml"), 'name = "vtc-mine"\n');
    writeFileSync(join(agents, "reviewer.toml"), 'name = "reviewer"\n');
    const result = await createCodexAdapter().install({ ...env, scope: "project" });
    expect(readdirSync(agents).sort()).toEqual([
      "reviewer.toml",
      "vtc-engineer.toml",
      "vtc-mine.toml",
      "vtc-qa-judge.toml",
    ]);
    expect(result.notes.join(" ")).toContain("vtc-old-role.toml");
  });

  it("refuses a missing plugin or one for another host", async () => {
    const env = setup();
    await expect(
      createCodexAdapter().install({ ...env, pluginDir: temp("vtc-empty-"), scope: "user" }),
    ).rejects.toThrow(/missing vtc-manifest.json/);
    const claude = temp("vtc-claude-plugin-");
    writeFixturePlugin("claude-code", claude);
    await expect(
      createCodexAdapter().install({ ...env, pluginDir: claude, scope: "user" }),
    ).rejects.toThrow(/claude-code plugin/);
  });
});

describe("upsertMcpServerTable", () => {
  it("appends to an empty config", () => {
    expect(upsertMcpServerTable("", "vtc", TABLE)).toBe(TABLE);
  });

  it("refuses an engine entry defined inline or with dotted keys", () => {
    expect(() =>
      upsertMcpServerTable('[mcp_servers]\nvtc = { command = "x" }\n', "vtc", TABLE),
    ).toThrow(/outside a \[mcp_servers.vtc\] table/);
    expect(() => upsertMcpServerTable('mcp_servers.vtc.command = "x"\n', "vtc", TABLE)).toThrow();
    expect(
      upsertMcpServerTable('[mcp_servers]\nvtcx = { command = "x" }\n', "vtc", TABLE),
    ).toContain("vtcx");
  });
});

describe("upsertMcpServerTable: forms a line editor must not touch", () => {
  it("refuses a root inline mcp_servers table, which an appended [mcp_servers.vtc] would duplicate", () => {
    expect(() =>
      upsertMcpServerTable('mcp_servers = { vtc = { command = "x" } }\n', "vtc", TABLE),
    ).toThrow(/outside a \[mcp_servers.vtc\] table/);
    expect(() => upsertMcpServerTable("mcp_servers = {}\n", "vtc", TABLE)).toThrow();
  });

  it("reads a header-like line inside a multi-line string as text, not as a table", () => {
    const config = [
      'notes = """',
      "[mcp_servers.vtc]",
      'command = "not a key"',
      '"""',
      "literal = '''",
      "[mcp_servers.vtc]",
      "'''",
      'model = "o3"',
      "",
    ].join("\n");
    const out = upsertMcpServerTable(config, "vtc", TABLE);
    expect(out.startsWith(config.trimEnd())).toBe(true);
    expect(out.endsWith(TABLE)).toBe(true);
  });

  it("still replaces its own table after a closed multi-line string", () => {
    const config = ['notes = """one', 'two"""', "", "[mcp_servers.vtc]", 'command = "old"'].join(
      "\n",
    );
    const out = upsertMcpServerTable(config, "vtc", TABLE);
    expect(out.match(/\[mcp_servers\.vtc\]/g)).toHaveLength(1);
    expect(out).not.toContain("old");
  });
});
