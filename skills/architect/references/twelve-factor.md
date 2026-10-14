# The twelve factors, as decisions to check

Paraphrased from and linked to The Twelve-Factor App (12factor.net, Adam Wiggins). Each factor is
stated as a rule the spine can carry, with a way to check it.

| #   | Factor              | Rule for the spine                                                            | How to check it                                             |
| --- | ------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Codebase            | One repository per deployable app, many deploys of it                         | Repo layout review; no copy-pasted service code             |
| 2   | Dependencies        | Declare and pin every dependency; nothing implicit from the host              | Lockfile present and enforced in CI (frozen install)        |
| 3   | Config              | Config that varies per deploy lives in the environment, never in code         | A secret scanner and a lint rule against hard-coded hosts   |
| 4   | Backing services    | Databases, queues, caches are attached resources, swappable by config         | Integration tests run against a container from config       |
| 5   | Build, release, run | Separate stages; a release is an immutable build plus config                  | CI produces one artifact promoted through environments      |
| 6   | Processes           | Stateless processes; state lives in a backing service                         | No local-disk session state; kill-an-instance test          |
| 7   | Port binding        | The app exports its service by binding a port itself                          | Container health check on the declared port                 |
| 8   | Concurrency         | Scale out by process type (web, worker), not by bigger machines               | Process types declared; horizontal scaling configured       |
| 9   | Disposability       | Fast start, graceful shutdown on SIGTERM; work is resumable                   | Shutdown test: in-flight work finishes or is re-queued      |
| 10  | Dev/prod parity     | Same backing service kinds and versions in development and production         | Dev environment uses the same database engine as production |
| 11  | Logs                | Logs are an event stream to stdout; the platform routes them                  | No log files written by the app; structured log format lint |
| 12  | Admin processes     | Migrations and one-off tasks run as the same release, in the same environment | Migrations are part of the release, not run by hand         |

## Beyond the original twelve

- **Telemetry:** metrics and traces alongside logs, with a correlation id across services.
- **Security:** secrets from a secret store, least-privilege identities per process type.
- **API first:** the contract (OpenAPI, protobuf, an event schema) is versioned and checked for
  breaking changes in CI.

## When not to apply a factor

A CLI tool, a desktop app or an embedded system does not bind ports or scale by process type.
Mark such factors "not applicable" with the reason instead of forcing them.
