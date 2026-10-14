---
name: design-craft
description: VTC design craft references (spec §9.1) - screen modes (Persuade, Operate, Read, Experience), new-work steps 1-5 for distinct directions inside the engine's dealt constraints, the per-screen Direction contract (THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, FORM, FINISH), the craft floor and the font blocklist. Load when designing a user interface or judging one against its design.
---

# Design craft

Sources: forked from pbakaus/impeccable (https://github.com/pbakaus/impeccable, Apache-2.0, see
NOTICE) at commit 2f98774f86bc05563876643db37e6c37c322850f: `skill/SKILL.src.md` (modes, how to
design), `skill/reference/new-work.md` (steps 1–5, colour strategy, faces, calibration, the
Direction contract), `skill/reference/craft-floor.md` and `skill/reference/mode-operate.md`,
`mode-persuade.md` and `mode-read.md`. Modified by VTC: reworded and cut to the Designer and
Visual QA contracts. The upstream's commands, scripts, decision page, image comps, hosted
catalog, telemetry and project files are not used: the direction roll is the engine's local
constraints lottery, the human chooses at G2, and the design tokens stay the source of truth.

## How to use these references

Read a reference when a step needs it, not all of them up front.

| Step                                                 | Read                                                 |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Choosing each screen's mode                          | ${CLAUDE_SKILL_DIR}/references/modes.md              |
| A new design: the rut, candidate worlds, directions  | ${CLAUDE_SKILL_DIR}/references/new-work.md           |
| Writing a Direction contract, or judging against one | ${CLAUDE_SKILL_DIR}/references/direction-contract.md |
| Before building any screen, and before judging one   | ${CLAUDE_SKILL_DIR}/references/craft-floor.md        |

## The core in one page

- **The brief wins.** A pinned aesthetic, era, material, font or palette in the specification
  is honoured even when it lands on a look listed below. Redirecting a clear brief toward your
  own taste is a failure.
- **Extend or invent.** A screen, feature or state inside an established product inherits its
  world: resolve only the new purpose, content, hierarchy, states and interaction. Only a new
  product, or a requested replacement of the visual world, gets new directions.
- **One mode per screen.** Persuade (the visitor decides and acts), Operate (the visitor
  completes a task), Read (the visitor understands something), Experience (the visitor is
  inside the work). The mode comes from the screen, not the product: a tool's landing page is
  Persuade, a fashion house's documentation is Read.
- **Colour strategy before colours.** Restrained, Committed, Full or Drenched (the engine deals
  one). Colour commits at page scale. Dark or light is never a default: one sentence of
  physical scene (who, where, under what light) decides it.
- **Calibration.** Generated interfaces cluster on a few looks whatever the subject: a warm
  cream ground with a high-contrast serif display and a terracotta or signal-red accent;
  near-black with one neon accent and glowing edges; broadsheet hairlines, an italic display
  serif and small tracked mono labels; flat saturated ink with black boxes, hard offset shadows
  and heavy condensed type. Each is legitimate when the brief asks for it. Where the brief
  leaves the look free, landing in one means the self-check failed: if someone could guess the
  look from the category alone, rework it.
- **Truth binds claims, not demonstrations.** Illustrative content may be authored at full
  fidelity and labelled synthetic; prices, customers, benchmarks and capabilities the product
  does not have are never invented.
- **Bounded passes.** Build fully, inspect once at every width and theme together, fix
  everything that inspection shows in one batch, confirm once, stop.

## The font blocklist

Choose faces like objects from the subject's world, in the screen's mode. Operate and Read
screens are well served by system stacks and workhorse interface faces; Persuade and Experience
screens want a face with a point of view. These training-data defaults mean the search stopped
early:

- Serif display: Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, DM Serif.
- Sans and mono: Syne, Space Grotesk, Space Mono, IBM Plex, DM Sans, Outfit, Plus Jakarta Sans,
  Instrument Sans, and Inter as a display face.

Naming one anyway needs a reason no other face could satisfy, written into the Direction
contract. A subject association is never that reason: books wanting a serif and technology
wanting a monospace are the associations the list exists to break. When the dealt type pairing
names a blocklisted face, keep the pairing's roles and contrast and pick the faces from outside
the list.
