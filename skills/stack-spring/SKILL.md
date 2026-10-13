---
name: stack-spring
description: "Spring Boot stack pack (VTC spec 5.2a). Load for a task whose code uses Spring Boot (detected from a Spring Boot dependency in Maven or Gradle files): conventions, pitfalls and test commands."
---

# Spring Boot (Java and Kotlin) stack pack

Detect: `spring-boot` in `pom.xml` or `build.gradle*`; `@SpringBootApplication`.

## Conventions

- Layers as the project has them: controllers thin, services transactional, repositories for data
  access.
- Constructor injection; no field injection in new code.
- Request DTOs validated with Bean Validation; entities never exposed directly as API responses.
- Configuration through typed configuration properties; profiles for environments.

## Pitfalls

- Transactional methods called from the same class bypass the proxy and run without a transaction.
- Lazy relationships loaded outside a transaction or in loops cause errors or N+1 queries.
- String-built JPQL or SQL is injection; use parameters.
- Blocking calls inside a reactive stack stall it.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Tests through the build tool's test task; slice tests for web and data layers, full context
  tests sparingly.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
