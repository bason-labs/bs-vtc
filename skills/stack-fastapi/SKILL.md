---
name: stack-fastapi
description: "FastAPI stack pack (VTC spec 5.2a). Load for a task whose code uses FastAPI (detected from fastapi in the Python dependency files): conventions, pitfalls and test commands."
---

# FastAPI stack pack

Detect: `fastapi` in requirements, pyproject or a lockfile; an ASGI app object.

## Conventions

- Request and response bodies are Pydantic models; routes declare response models so output is
  filtered.
- Shared resources (database sessions, current user) come through dependencies.
- Routers per feature, included in the app; settings through one settings object.
- Async routes call only non-blocking libraries; blocking calls go in sync routes or a thread
  pool.

## Pitfalls

- A blocking call inside an async route stalls the whole event loop.
- Returning ORM objects without a response model can leak fields.
- Authentication dependencies must be on every protected route, not assumed from a router.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Tests usually use pytest with the framework's test client; type checks with the project's
  checker.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
