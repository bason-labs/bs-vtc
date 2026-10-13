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

Both also get:

- `NOTICE`;
- `vtc-manifest.json` (`PLUGIN_MANIFEST_ASSET`), validated against `PluginManifestSchema` from
  `@vtc/shared`: agents with role, mode, kind, discipline, version and `promptShaFor` of their
  instructions; skills with kind and pack id;
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
- **Advisors go through `consult`** (spine §5 reading 25). The Lead skill's Advisors section and
  `/vtc advise` call the engine's `consult` tool, spawn the one `spawn_role` it returns and
  `submit` the result, so advisor calls are logged, priced and budgeted like any role. The
  agents' descriptions say they run only when the Lead consults them, so a host does not pick
  them for other work.
- **Agent names.** The engine names agents `agentNameFor(role, mode)` (`vtc-qa-judge`), and the
  Lead spawns `spawn_role.agent` exactly as given on both hosts. A host that namespaces plugin
  agents (Claude Code: `vtc:vtc-qa-judge`) gets the namespace from its adapter, inside the
  `SubagentInstruction` (AD-14 rule 1), never from the Lead.
- **Model tier on Codex** (spine §5 reading 26). Claude Code maps the role's tier to a model
  alias (top/mid/low = opus/sonnet/haiku). A Codex agent never pins a model: it sets only
  `model_reasoning_effort` and runs on the session's model, and the compiler rejects a Codex
  model in `role.yaml`. The tier-to-model map lives in the Codex adapter's defaults and
  `project.yaml` `hosts.models.codex`; until the spike names Codex model ids, per-host scoring
  must not assume tiers differ on Codex.
- The Codex manifest fields are provisional until the sub-project 0 spike confirms them (spike
  item proposed for spine §7).
- AD-9 applies to every file here and every emitted file: no permission-bypass flag, no credential
  path or credential variable, not even in a "never do this" list. The compile step fails on one.
- Host adapters' `install` only places or registers what the compiler emitted.
