---
name: lens-i18n
description: Internationalisation and content review lens (VTC spec 5.3). Use when a task adds or changes user-facing strings, date, number or currency formatting, locale handling or right-to-left support; cite the rule id.
---

# Internationalisation and content lens

Applies to: user-facing strings, locale formatting, RTL layouts.

- **I18N-1** No sentence built by concatenation; each message is one complete string with named
  placeholders.
- **I18N-2** Plurals use the locale's plural categories (ICU or the platform equivalent) and
  always include the "other" form.
- **I18N-3** Dates, numbers, currencies, percentages and lists are formatted by the platform's
  locale-aware formatter, never by hand.
- **I18N-4** Layout uses logical properties (start and end, not left and right) so RTL locales
  mirror correctly.
- **I18N-5** Text containers tolerate about 35% expansion; truncation is a deliberate choice per
  message.
- **I18N-6** New strings carry a description for translators where the meaning is ambiguous.
- **I18N-7** Text is compared with locale-aware collation, truncated on grapheme boundaries, and
  case-changed with a locale.
- **I18N-8** Locale comes from the user's choice and negotiation, with a defined fallback chain;
  never from IP location alone.
- **I18N-9** No hard-coded user-facing string outside the message catalogue when the project has
  one.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-i18n-engineer.md,
specialized-cultural-intelligence-strategist.md (name and date checks).
