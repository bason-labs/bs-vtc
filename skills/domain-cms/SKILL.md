---
name: domain-cms
description: "CMS (WordPress and Drupal) domain pack (VTC spec 5.2a). Load when the repository or the specification shows a WordPress or Drupal codebase (wp-config.php, wp-content, composer drupal/core, *.info.yml); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# CMS (WordPress and Drupal) domain pack

Load when: a WordPress or Drupal codebase (wp-config.php, wp-content, composer drupal/core,
*.info.yml).

## Rules

- **CMS-1** Never modify core, a parent theme or a contributed plugin or module; extend through
  hooks, filters, child themes and custom modules.
- **CMS-2** Configuration lives in code: Drupal configuration exports, WordPress constants and
  code, never only in the database.
- **CMS-3** Content types, fields and taxonomies are registered in code.
- **CMS-4** A new plugin or module is vetted (maintenance, installs, open security advisories) and
  named by the task.
- **CMS-5** Escape all output with the CMS's escaping functions; sanitise and validate input; use
  nonces or form tokens on state-changing requests.
- **CMS-6** Database access goes through the CMS's query APIs with placeholders; no interpolated
  SQL.
- **CMS-7** Measure before optimising: page caching never caches personalised pages; no unbounded
  queries; autoloaded options stay small.
- **CMS-8** Accessibility is part of every template (WCAG 2.1 AA at least).

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-cms-developer.md,
engineering-wordpress-performance.md, engineering-drupal-performance.md.
