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
    hooks/hooks.json             extra defence only (AD-8 rule 3)
  codex/
    plugin.json                  plugin manifest
    hooks/hooks.json             extra defence only; Codex asks the user to trust them
```

What the compiler emits per host:

| Host        | Agents                                          | Skills and commands                        | MCP entry                                             |
| ----------- | ----------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Claude Code | `agents/vtc-*.md` (frontmatter + instructions)  | `skills/*/SKILL.md`, `commands/vtc.md`     | `.mcp.json` from this directory                       |
| Codex       | `agents/vtc-*.toml` (the installer copies them) | `skills/*/SKILL.md`, `skills/vtc/SKILL.md` | `.mcp.json` generated from `engineMcpServer("codex")` |

Both also get `NOTICE` and `vtc-manifest.json` (agents with role, mode, kind, discipline, version
and prompt SHA-256; skills with kind and pack id).

- Hooks call `vtc hook <event> --host <host>`, which the cli provides; it must exit 0 when no VTC
  run is active, so normal sessions are never blocked.
- The Codex manifest fields and hook matchers are provisional until the sub-project 0 spike
  confirms them (spine §7).
- AD-9 applies to every file here and every emitted file: no permission-bypass flag, no credential
  path or credential variable, not even in a "never do this" list. The compile step fails on one.
- Host adapters' `install` only places or registers what the compiler emitted.
