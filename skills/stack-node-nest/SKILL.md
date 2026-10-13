---
name: stack-node-nest
description: "Node.js (Express, Fastify or NestJS) stack pack (VTC spec 5.2a). Load for a task whose code uses Node.js (Express, Fastify or NestJS) (detected from package.json server dependencies): conventions, pitfalls and test commands."
---

# Node.js and NestJS stack pack

Detect: `express`, `fastify`, `@nestjs/core` or `koa` in package.json; a server entry file.

## Conventions

- NestJS: one module per feature with controllers thin, providers holding logic, DTOs validated
  with the project's validation pipe.
- Express or Fastify: follow the existing router and middleware layout; validation through the
  project's schema library.
- Configuration comes from one typed config module reading the environment once at startup.
- Errors go through the framework's error handling to the project's error shape.

## Pitfalls

- An unhandled promise rejection or a thrown error in a callback crashes or hangs the request;
  await everything and handle errors centrally.
- Blocking the event loop with CPU-heavy work or synchronous I/O stalls every request.
- Database clients and pools are created once, not per request.
- Untrusted input in file paths, shell commands or dynamic requires is injection.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Unit tests with the project's runner (Jest or Vitest); HTTP tests with the framework's injection
  helper or supertest.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
