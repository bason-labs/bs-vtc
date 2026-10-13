---
name: domain-us-public-sector
description: "US public sector (USWDS and Section 508) domain pack (VTC spec 5.2a). Load when the repository or the specification shows a US federal or public-sector site (USWDS in dependencies, a .gov domain, Section 508 or 21st Century IDEA requirements in the specification); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# US public sector (USWDS and Section 508) domain pack

Load when: a US federal or public-sector site (USWDS in dependencies, a .gov domain, Section 508
or 21st Century IDEA requirements in the specification).

## Rules

- **GOV-1** Theme through USWDS settings and tokens; no ad-hoc CSS overriding the framework.
- **GOV-2** Use the maintained USWDS component before building a custom one; customise only
  through documented settings, utilities and variants.
- **GOV-3** The official government banner and the agency identifier are present and correct.
- **GOV-4** Section 508 and WCAG 2.1 AA at least: customisations never regress the components'
  accessibility.
- **GOV-5** Mobile first with the USWDS grid and breakpoints.
- **GOV-6** Spacing, type and colour come from the system tokens; contrast stays at 4.5:1 for text
  and 3:1 for UI.
- **GOV-7** USWDS is pinned and upgradeable: customisations isolated from the package.
- **GOV-8** Sites meet the 21st Century IDEA requirements: accessible, consistent, mobile-
  friendly, secure and user-centred.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-uswds-developer.md,
engineering-section-508-specialist.md.
