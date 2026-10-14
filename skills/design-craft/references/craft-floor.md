# Craft floor

Derived from pbakaus/impeccable (Apache-2.0, see NOTICE) at commit
2f98774f86bc05563876643db37e6c37c322850f: `skill/reference/craft-floor.md`. Modified by VTC:
reworded for the Designer's prototype and Visual QA's screenshots; the editor-hook note and the
model-specific block are left out, and the motion check names what a screenshot cannot show.

Read this after the direction is settled and before building, and build without announcing the
checklist. A pinned brief or the chosen direction overrides anything here; habit does not. The
floor holds the mechanics; it never picks the direction. With every check green, spend the
screen on the chosen world, and when torn between refined and committed, commit.

## Verify

Each item is a check on the built result, not an intention. Run them together in one batched
inspection (every width and theme at once), not as separate trips.

- **Contrast:** body and placeholder text at least 4.5:1, large text at least 3:1. On a coloured
  surface, tint secondary text from that hue or the foreground; never grey.
- **Depth:** shadows carry an offset and a soft blur. A zero-offset coloured halo is decoration.
- **Spacing:** tight groups, generous separation, more space above a heading than below it.
- **Type:** body measure 65–75ch, display type at most 6rem, letter-spacing no tighter than
  -0.04em, balanced headings, obvious steps of scale and weight. Run the real copy at every width
  and fix what overflows.
- **Motion:** one authored moment, not scattered effects and not one identical entrance on every
  section; exponential ease-out from an already-visible default. A screenshot cannot show it, so
  the motion token and the signature interaction's spec carry it.
- **States:** hover, focus, disabled, loading, error and empty, plus real content, working
  controls and a composition that holds at every width.
- **Browser surfaces:** the parts nobody drew still carry the design. Text selection, the caret,
  scrollbars, focus rings, underline offset and tabular numerals ship with browser defaults that
  belong to no design system; theme them from the tokens. It is the cheapest sign that a screen
  was built rather than assembled, and the one most often skipped.
- **Copy:** the product's own language. Controls name their action; errors name the problem and
  the recovery.
- **Coverage:** every requirement the screen covers is present and findable within seconds.

## Refuse

These are the category's defaults, not bans: the brief's own words can earn any of them, except
the one marked as a ban. Reaching for one when the choice is free means nothing was decided;
rewrite the element rather than softening it.

Page scaffolds:

- Same-size cards of icon, heading and text as the page structure. Cards are the lazy container,
  and nested cards are always wrong.
- The hero-metric template: a big number, a small label, supporting stats and an accent.
- A kicker or eyebrow label above a heading. This one is a ban: no brief earns it back. The
  heading carries its own weight.
- Section numbers (01, 02, 03) unless the sequence itself is information the reader needs.
- A modal for a task that needs neither interruption nor protected focus.

Surface habits:

- Gradient text. Emphasis comes from weight or size.
- Glass and blur as decoration rather than as a specific effect.
- A coloured `border-left` or `border-right` wider than 1px on cards, list items, callouts or
  alerts (side-stripe borders).
- A hard offset shadow (zero blur) outside a world that actually chose it.
- Sparklines, progress rings and soft-shadowed rounded rectangles standing in for content.
- Monospace as a costume for "technical" rather than for code, data or measurement.
- A system display face (Impact, Arial Black, the platform sans) as the display voice of a
  committed world.
- Unicode glyphs or emoji standing in for an icon system: icons come from one real library or
  authored SVG, in one stroke and weight.
- Geometric masks (a circle, polygon or radial cut-out) approximating a photograph's edges.
- Light or dark picked by category instead of by the use scene.
