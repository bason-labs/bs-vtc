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
    plugin.json                  plugin manifest
```

The compiler accepts only these files in the host directories (`HOST_PLUGIN_FILES`).

What the compiler emits per host:

| Host        | Agents                                          | Skills and commands                        | MCP entry                                             |
| ----------- | ----------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Claude Code | `agents/vtc-*.md` (frontmatter + instructions)  | `skills/*/SKILL.md`, `commands/vtc.md`     | `.mcp.json` from this directory                       |
| Codex       | `agents/vtc-*.toml` (the installer copies them) | `skills/*/SKILL.md`, `skills/vtc/SKILL.md` | `.mcp.json` generated from `engineMcpServer("codex")` |

Both also get `NOTICE` and `vtc-manifest.json` (agents with role, mode, kind, discipline, version
and prompt SHA-256 as defined by `promptSha256`; skills with kind and pack id). The manifest is
**provisional and compiler-internal**: no other package reads it until `PluginManifestSchema`
is in `@vtc/shared` (AD-3; proposed to the integrator).

- **No hooks yet.** Hooks are an extra layer of defence only (AD-8 rule 3), and the command they
  would run (`vtc hook <event> --host <host>`) has no cli contract yet; the compiler rejects
  `plugins/<host>/hooks/**` until one exists (proposed to cli-binary).
- **Role agents cannot reach the Lead's tools.** Claude Code agents get an explicit `tools:`
  allowlist without the engine's run-driving tools. Each Codex agent file carries its own
  `[mcp_servers.vtc]` entry: disabled, or limited to the role's engine tools with
  `enabled_tools`. That per-agent entry is provisional until the spike confirms Codex honours it
  (spine §7).
- **Codex sandbox gap.** A Codex `sandbox_mode` limits what an agent's commands may write, not
  whether it may run a shell, and write-scoped agents need `workspace-write`. So on Codex "run no
  shell command" is an instruction, not a host restriction, and the write paths are not a host
  deny; the engine's write-scope check is the enforcement point (spike item proposed for §7).
- **Advisors.** `vtc-advisor-*` agents (§5.4) run outside the run: the Lead skill calls them
  only at the human's request and never submits their advice to the engine (reading recorded in
  `roles/README.md`). Their description says so, so a host does not pick them for other work.
- **Agent names.** The engine names agents `agentNameFor(role, mode)` (`vtc-qa-judge`). Claude
  Code exposes plugin agents under the plugin's namespace (`vtc:vtc-qa-judge`); the Lead skill
  says so. To be confirmed by the spike.
- The Codex manifest fields are provisional until the sub-project 0 spike confirms them
  (spine §7).
- AD-9 applies to every file here and every emitted file: no permission-bypass flag, no credential
  path or credential variable, not even in a "never do this" list. The compile step fails on one.
- Host adapters' `install` only places or registers what the compiler emitted.
