---
name: lens-a11y
description: Accessibility review lens (VTC spec 5.3). Use on every UI task; the automated accessibility scan always runs first, and this lens covers what scanners miss (focus order, names, keyboard use, custom widgets); cite the rule id and the WCAG criterion.
---

# Accessibility lens (WCAG 2.2 AA)

Applies to: every UI task. The axe scan runs first and its violations are not repeated here.

- **A11Y-1** Every interactive element is reachable and operable by keyboard alone, in a logical
  order, with a visible focus indicator (WCAG 2.1.1, 2.4.3, 2.4.7, 2.4.11).
- **A11Y-2** Native elements before ARIA; custom widgets (tabs, menus, dialogs, comboboxes, date
  pickers) follow the WAI-ARIA authoring pattern including keyboard behaviour (4.1.2).
- **A11Y-3** Every control has an accessible name that matches its visible label (2.5.3, 4.1.2).
- **A11Y-4** Dialogs move focus in, trap it while open, and return it on close.
- **A11Y-5** Form errors are announced, describe how to fix the input, and are tied to their
  field (3.3.1, 3.3.3).
- **A11Y-6** Text contrast at least 4.5:1, large text and UI components 3:1; information is never
  conveyed by colour alone (1.4.3, 1.4.11, 1.4.1).
- **A11Y-7** Content reflows at 320 CSS px and works at 200% text zoom without loss (1.4.10,
  1.4.4); targets are at least 24 by 24 px (2.5.8).
- **A11Y-8** Images that inform have alternative text; decorative ones are hidden from assistive
  technology (1.1.1).
- **A11Y-9** Motion respects the reduced-motion preference; nothing flashes more than three times
  a second (2.3.1).
- **A11Y-10** Dynamic updates (toasts, live results, loading) are announced through a live region
  without stealing focus (4.1.3).

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): testing-accessibility-auditor.md
(its default-to-fail bias removed), engineering-section-508-specialist.md (widget contracts).
