# plugins/

Hand-written host plugin sources (spec §4.1 "Host plugins", §4.4; spine AD-16), compiled by
`packages/compiler` together with `roles/` and `skills/` into `dist/claude-plugin` and
`dist/codex-plugin` (and the binary's `AssetBundle` namespaces `plugin:claude-code` and
`plugin:codex`). Nothing under `dist/` is hand-edited.

```
plugins/
  common/
    skills/lead/SKILL.md   the Lead skill: the engine loop start → next → dispatch → submit
    commands/vtc.md        the /vtc command (Claude Code: a command; Codex: the `vtc` skill)
  claude-code/
    .claude-plugin/plugin.json   plugin manifest
    .mcp.json                    the engine entry, equal to engineMcpServer("claude-code")
  codex/
    plugin.json                  portable Agent Plugins manifest ($schema agent-plugins.org 1.0.0)
```

The compiler accepts only these files in the host directories (`HOST_PLUGIN_FILES`).

What the compiler emits per host:

| Host        | Agents                                          | Skills and commands                        | MCP entry                                                    |
| ----------- | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Claude Code | `agents/vtc-*.md` (frontmatter + instructions)  | `skills/*/SKILL.md`, `commands/vtc.md`     | `.mcp.json` from this directory                              |
| Codex       | `agents/vtc-*.toml` (the installer copies them) | `skills/*/SKILL.md`, `skills/vtc/SKILL.md` | `mcp.json` generated from `engineMcpServer("codex")` (below) |

**The Codex plugin follows the portable Agent Plugins 1.0 layout**
(developers.openai.com/plugins/build/plugins; schemas under agent-plugins.org/schemas/1.0.0/):
a root `plugin.json` with the required `$schema` and `name` (the compiler checks both), skills
discovered from `skills/`, hooks from `hooks/hooks.json`, and the bundled MCP servers in a root
`mcp.json` (`CODEX_MCP_FILE`). The portable format needs a transport `type` on every server, so
the entry is `{ "type": "stdio", "command": "vtc", "args": ["engine", "--mcp", "--host",
"codex"] }` under `mcpServers`, with the file's own `$schema`; a Claude Code `.mcp.json` is not
just renamed. The compiler refuses a hand-written `plugins/codex/mcp.json` or `.mcp.json`.

Both also get:

- `NOTICE`;
- `vtc-manifest.json` (`PLUGIN_MANIFEST_ASSET`), validated against `PluginManifestSchema` from
  `@vtc/shared`: agents with role, mode, kind, discipline, version, `promptShaFor` of their
  instructions, and the SHA-256 of their locked and default editable parts (`locked_sha256`,
  `editable_sha256`, AD-21 rule 2); skills with kind and pack id;
- `vtc/prompts/<agent>/locked.md` and `editable.md` (`rolePromptAssetPath`): each agent's two
  prompt parts as rendered for the host, so the engine can render the default editable section
  in a task pack and compute `effectivePromptSha` of any pinned version (see roles/README.md,
  "Prompt parts and Lookback");
- `vtc/role-contracts.json` (`ROLE_CONTRACTS_ASSET`): every role's `RoleContract`, validated with
  `RoleContractSchema`, which the engine loads from the `AssetBundle` (AD-14 rule 6);
- `hooks/hooks.json`: `SessionStart`, `PreToolUse` and `SubagentStop` wired to
  `vtcHookCommand(event, host)` (`vtc hook <event> --host <host>`), each with the timeout
  `VTC_HOOK.timeoutMs` in seconds (spine §5 reading 31). Generated, never hand-written: the
  compiler rejects `plugins/<host>/hooks/**`. Hooks are an extra layer of defence only (AD-8
  rule 3); the command fails open and the engine stays the enforcement point. Host event names
  and the Codex hook format are provisional until the spike (spine §7). The hooks run a bare
  `vtc` from `PATH` in every session where the plugin is enabled, VTC run or not, on session
  start, subagent stop and every `Bash`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit` call.
  They need the `vtc` binary on `PATH`: without it (a dev checkout run as `node dist/bin.js`, or
  a plugin installed without the binary) the host reports a hook error on each of those events.
  Nothing is blocked, since a missing command is not the block exit, but the noise is constant.
  Whether the adapter's install checks for `vtc` or the hooks run through a plugin-root shim is
  proposed as a question for the hook-wiring spike row (spine §7).

- **Role agents cannot reach the Lead's tools.** Claude Code agents get an explicit `tools:`
  allowlist: the read tools, file writes for write-scoped profiles, `Bash` for the Engineer
  family only, and only the role-facing engine tools their contract declares (`ROLE_MCP_TOOLS`:
  `research_fetch`, `fact_lookup`, `fact_propose`), by their plugin names. The engine's
  run-driving tools are never in it. The human-only tools (`HUMAN_ONLY_TOOLS`: `approve`,
  `answer`, `change_request`; D-an, spine §5 reading 71) are refused at three points:
  `role.yaml` may not name one, the renderers throw if one reaches them, and every Claude Code
  agent also names each in `disallowedTools` (`CLAUDE_DENIED_TOOLS`, bare tool names only: a
  specifier there would remove the whole tool, reading 81). A Codex agent file cannot set
  `mcp_servers`: it inherits the session's bridge (reading 82), so on Codex the engine's
  Lead-only and human-channel checks are the barrier.
- **Skills an agent preloads** (`ROLE_SKILLS`, `TOOL_SKILLS`). An agent's `tools` never include
  `Skill`, so a Claude Code agent preloads what it needs through its `skills` frontmatter, by
  the plugin-namespaced name: the Architect its `architect` reference skill, and every agent
  that declares a research tool the skill that teaches it (`research-fetch`, `research-facts`).
  The compile step fails when such a skill is missing. A Codex session lists every installed
  skill with its path, so a Codex agent names none. Skill files reference their own files as
  `${CLAUDE_SKILL_DIR}/references/<file>.md`, which Claude Code substitutes; the Codex copy
  drops the prefix, leaving a path relative to `SKILL.md`. That Claude Code resolves a plugin
  skill named `vtc:<skill>` in a plugin agent's `skills` list, and substitutes the directory in
  a preloaded skill, is proposed as a spike row (spine §7).
- **No role touches VTC's own guard rails** (D-w, D-an, D-ap; spine §5 readings 43, 71, 73 and
  81; `ROLE_DENIED_VTC`). The compiled agents carry no path or command deny list: in an agent's
  frontmatter a rule specifier would remove the whole tool (reading 81), and a Codex agent file
  cannot deny a command or a path. The guarded VTC-home globs and `vtc calibrate` are
  `permissions.deny` rules and sandbox deny lists that `@vtc/shared` builds from
  `ROLE_DENIED_VTC` (`claudeSessionPermissionDeny`): the Lead session's settings that
  `vtc install` writes, and a headless run's `--settings` (adapters). Wave 3's globs
  (`WAVE3_HOME_WRITE_DENY`: the Lookback versions and pins, the research cache, the browser
  store, the design library) reach roles the same way, once the integrator folds them into
  `ROLE_DENIED_VTC.homeWriteDeny`; the compiler has no list of its own to extend.
- **Codex sandbox gap.** A Codex `sandbox_mode` limits what an agent's commands may write, not
  whether it may run a shell. A Codex agent file turns off what it may (`[features]`
  `shell_tool = false` for every role but the Engineer family, `request_permissions_tool =
false` for all, reading 82), but the write paths are not a host deny; the engine's
  write-scope check is the enforcement point.
- **Advisors go through `consult`** (spine §5 reading 25). The Lead skill's Advisors section and
  `/vtc advise` call the engine's `consult` tool, spawn the one `spawn_role` it returns and
  `submit` the result, so advisor calls are logged, priced and budgeted like any role. The
  agents' descriptions say they run only when the Lead consults them, so a host does not pick
  them for other work.
- **Agent names.** The engine names agents `agentNameFor(role, mode)` (`vtc-qa-judge`), and the
  Lead spawns `spawn_role.agent` exactly as given on both hosts. A host that namespaces plugin
  agents (Claude Code: `vtc:vtc-qa-judge`) gets the namespace from its adapter, inside the
  `SubagentInstruction` (AD-14 rule 1), never from the Lead.
- **Model tier on Codex** (spine §5 readings 26 and 51, D-ae). Claude Code maps the role's tier
  to a model alias (top/mid/low = opus/sonnet/haiku). A Codex agent never pins a model: it sets
  only `model_reasoning_effort` and runs on the session's model, and the compiler rejects a Codex
  model in `role.yaml`. The engine is the only model resolver (`project.yaml`
  `hosts.models.codex`, then its built-in map, which names no Codex ids until the spike does);
  with no id, `spawn_role` carries no `model` and the Lead passes none. Per-host scoring must not
  assume tiers differ on Codex.
- **Host identity of a role run.** The plugin is named `vtc` on both hosts and agent files carry
  the bare compiled name, so Claude Code lists them as `vtc:<agent>` and an engine-launched
  headless run resolves `--agent vtc:<agent>` (D-aa, reading 47). Headless `codex exec` has no
  `--agent` (spine §7, Codex headless role identity): each Codex agent file holds only top-level
  Codex config keys (`name`, `description`, `model_reasoning_effort`, `developer_instructions`,
  `features`), so whichever load path the spike confirms can use it unchanged.
- The Codex plugin's install path (a marketplace entry and `[plugins."vtc@<marketplace>"]`) stays
  a spine §7 spike row; the manifest and `mcp.json` follow the official portable format above.
- AD-9 applies to every file here and every emitted file: no permission-bypass flag, no credential
  path or credential variable, not even in a "never do this" list. The compile step fails on one.
- Host adapters' `install` only places or registers what the compiler emitted.
