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
  `enabled_tools`. Unverified: spine §7 does not yet list a check that spawned Codex agents honour
  that per-agent entry, and the engine cannot tell a role agent's call from the Lead's (the bridge
  tags only the host, AD-12 rule 3). Both the spike item and an engine-side guard on `approve`,
  `answer`, `submit` and `change_request` are proposed to the integrator; until they land, this
  entry is the only barrier on Codex.
- **Codex sandbox gap.** A Codex `sandbox_mode` limits what an agent's commands may write, not
  whether it may run a shell, and write-scoped agents need `workspace-write`. So on Codex "run no
  shell command" is an instruction, not a host restriction, and the write paths are not a host
  deny; the engine's write-scope check is the enforcement point (spike item proposed for §7).
- **Advisors are compiled but held out of the Lead loop.** `vtc-advisor-*` agents (§5.4) are
  emitted, but the Lead skill neither names nor spawns them and `/vtc` has no `advise`: AD-4
  rule 1 lets the Lead dispatch only what `next` returns, and an advisor call would be invisible
  to AD-7 rule 11 traceability and to the AD-8 budget. They become callable through an
  engine-mediated `consult` action, or through a spine §5 reading that carves them out of those
  rules; both are proposed to the integrator (see `roles/README.md`). Their description says
  they run only when the Lead calls them, so a host does not pick them for other work.
- **Agent names.** The engine names agents `agentNameFor(role, mode)` (`vtc-qa-judge`), and the
  Lead spawns `spawn_role.agent` exactly as given on both hosts. A host that namespaces plugin
  agents (Claude Code: `vtc:vtc-qa-judge`) gets the namespace from its adapter, inside the
  `SubagentInstruction` (AD-14 rule 1), never from the Lead.
- **Model tier on Codex.** Claude Code maps the role's tier to a model alias (top/mid/low =
  opus/sonnet/haiku). A Codex agent pins a model only when `role.yaml` names one for Codex, and
  none does: every Codex role runs on the session's model and the tier maps only to
  `model_reasoning_effort`. Provisional until the spike names the Codex models per tier (proposed
  to the integrator); until then per-host scoring must not assume tiers differ on Codex.
- The Codex manifest fields are provisional until the sub-project 0 spike confirms them (spike
  item proposed for spine §7).
- AD-9 applies to every file here and every emitted file: no permission-bypass flag, no credential
  path or credential variable, not even in a "never do this" list. The compile step fails on one.
- Host adapters' `install` only places or registers what the compiler emitted.
