# plugins/

Hand-written host plugin sources (spec §4.1 "Host plugins", §4.4; spine AD-16). Owned by the
roles+compiler team.

```
plugins/
  common/        shared by both hosts: the Lead skill (Lead instructions), `/vtc …` command sources
  claude-code/   plugin manifest, hooks (extra defence only, AD-8), .mcp.json (the engine entry)
  codex/         Codex plugin manifest and hooks; the installer writes the MCP entry and agent TOML
```

- `packages/compiler` merges these with the compiled roles (`roles/`, `skills/`) into
  `dist/claude-plugin` and `dist/codex-plugin`, and into the binary's `AssetBundle`
  (`plugin:claude-code`, `plugin:codex`). Nothing under `dist/` is hand-edited.
- The MCP entry is `vtc engine --mcp --host <host>` (`engineMcpServer` in `@vtc/shared`);
  `compiler.test.ts` checks `claude-code/.mcp.json` against it.
- Host adapters' `install` only places or registers what the compiler emitted; they never author
  plugin content.
- AD-9 applies to every file here and to every emitted file: no permission-bypass flag, no
  credential path or credential variable, not even in a "never do this" list
  (`findForbiddenInText`, checked by `tooling/arch-tests`).

Populated in sub-project 3 (Lead skill content in sub-project 4).
