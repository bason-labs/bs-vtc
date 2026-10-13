---
name: domain-game-dev
description: "Game development domain pack (VTC spec 5.2a). Load when the repository or the specification shows a game project (Unity, Godot, Unreal or a web game engine); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# Game development domain pack

Load when: a game project (Unity, Godot, Unreal or a web game engine).

## Rules

- **GAME-1** Follow the engine's composition model: small single-purpose components or nodes, no
  deep inheritance.
- **GAME-2** Shared game data lives in the engine's data assets or resources, not in scene objects
  passed between scenes.
- **GAME-3** Systems communicate through events or signals with typed payloads, never by searching
  the scene graph at run time.
- **GAME-4** Editor-only code is separated from runtime code (editor folders, assembly definitions
  or guards) so builds do not break.
- **GAME-5** No allocation in per-frame hot paths; pool frequently spawned objects.
- **GAME-6** Frame-rate independent logic: scale by delta time; physics in the fixed step.
- **GAME-7** Typed scripting (static types in GDScript, strict C#) and the engine's naming
  conventions.
- **GAME-8** Multiplayer: the server or host is authoritative for game state; clients send intent,
  never results.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): game-development/unity/unity-
architect.md, unity-editor-tool-developer.md, unity-multiplayer-engineer.md, game-
development/godot/godot-gameplay-scripter.md, godot-multiplayer-engineer.md.
