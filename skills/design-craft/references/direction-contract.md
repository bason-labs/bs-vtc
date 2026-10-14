# The Direction contract

Derived from pbakaus/impeccable (Apache-2.0, see NOTICE) at commit
2f98774f86bc05563876643db37e6c37c322850f: `skill/reference/new-work.md` ("Record the decision").
Modified by VTC: it is written per key screen and per direction before G2 instead of into a
surface brief after a choice; FORM names the engine's dealt constraints instead of a seed
reference; FINISH ends at Visual QA's verdicts instead of the upstream's finish review and
documentation step.

## What it is

Six short blocks, about 150 words in all, that fix one direction for one key screen before any
of it is built. Each direction of a new design gets one, for the key screen whose first viewport
it prototypes; once the human has chosen, the chosen direction's contract is what the build and
Visual QA are held to. A block that reads like a mood means the direction is not decided yet.

- **THESIS**: the one idea this screen owns, and the category-default arrangement it refuses.
  The direction's `thesis` field is this line.
- **OWN-WORLD**: the palette and component language, specific enough to be recognised with all
  content removed.
- **STORY**: what the visitor understands, believes and does, in order.
- **FIRST VIEWPORT**: the exact composition: what is where and at what scale, and where the
  primary action sits.
- **FORM**: the chosen form, its position on your ordered list of candidate worlds, and the
  dealt constraints it builds in (colour strategy, type pairing, density and grid, radius and
  elevation, motion, signature interaction), named as dealt. A blocklisted face, if any, with
  the reason no other face could do.
- **FINISH**: the exit condition, verbatim: "unreviewed is unfinished; this screen is done when
  every state renders in both themes and Visual QA has judged the build against this contract".

## Where it goes

In the key screen's design contract file, under one `## Direction <id>` heading per direction,
after the screen's mode and product lens. Never copy it into the prototype or any other file a
browser loads: no HTML comments, hidden elements, `data-*` attributes or metadata. Reviewers get
it from the design contract.

## Example

```markdown
## Direction ledger-rail

- THESIS: Invoices are a ledger the owner reads top to bottom; this screen refuses the
  category's card grid of totals.
- OWN-WORLD: Bound-ledger green ground, ruled hairlines in brass, a condensed grotesque for
  figures and a humanist sans for labels; square controls, one raised surface.
- STORY: The owner sees what is overdue, believes the total is current, and sends one reminder.
- FIRST VIEWPORT: A running-balance rail on the left at full height; the overdue rows lead the
  table; "Send reminder" sits in the selected row, never in a floating bar.
- FORM: Ledger book, second on the list; dealt Committed colour, a condensed and humanist
  pairing, dense twelve-column grid, square radius with one elevation, quick linear motion,
  and a running balance that ticks as rows are selected.
- FINISH: unreviewed is unfinished; this screen is done when every state renders in both themes
  and Visual QA has judged the build against this contract
```
