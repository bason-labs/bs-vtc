---
name: stack-django
description: "Django stack pack (VTC spec 5.2a). Load for a task whose code uses Django (detected from django in the Python dependency files): conventions, pitfalls and test commands."
---

# Django stack pack

Detect: `django` in requirements, pyproject or a lockfile; `manage.py`; `settings.py`.

## Conventions

- Apps follow Django's layout (models, views, urls, forms or serializers, admin, migrations per
  app).
- Business rules live in models, managers or service functions, not in views or templates.
- Django REST Framework, when used: serializers validate, viewsets and permissions classes enforce
  access per object.
- Settings come from the environment through the project's settings module; never hard-code
  secrets.

## Pitfalls

- Querysets in loops cause N+1 queries; use select_related and prefetch_related.
- Migrations are generated with makemigrations and reviewed; a data migration needs a reverse
  function.
- Raw SQL and extra() with string formatting are injection; use parameters.
- Templates auto-escape; marking content safe on user input is a cross-site scripting bug.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Tests run with the project's runner (Django's test runner or pytest-django); check for missing
  migrations with the project's command.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
