# Changelog

All notable changes to `vtc` are listed here. Versions follow semver; while the version is 0.x,
any release may change behaviour. Role prompt changes have their own log in `roles/CHANGELOG.md`.

## v0.1.0 (2026-10-15)

The first internal release. It is private to the bason-labs/bs-vtc repository and not published
anywhere else. The binaries are unsigned (see "Not yet" below); check every download against
`SHA256SUMS`.

### What VTC does

- **A software company on your machine.** You talk to a Lead in Claude Code or Codex. Role agents
  (business analyst, architect, designer, engineers, QA, reviewers, Lookback and others) take an
  idea through spec, design, build, gates and review to a pull request. The engine is
  deterministic and checks every result against frozen contracts and gates.
- **Your own logins.** VTC runs on your Claude Code or Codex subscription and your `gh` login. It
  never handles an API key or a token, and it never bypasses a host's permission prompts.
- **Human gates.** G1 approves the requirements. G2 approves the design. For work VTC starts on
  its own, you review only the final pull request.
- **Fix loops with caps.** Gates and reviews send work back automatically. A loop that hits its
  round cap or gets stuck parks and asks you.
- **Model by difficulty.** The Planner sizes each task (S, M or L) and tags its risk. The
  engineer starts on Haiku, Sonnet or Opus (or the Codex equivalents) to match. It escalates
  after failed rounds, and reviewers drop a tier when 70% of the task budget is spent. The task
  view shows each run's tier and why it was picked.
- **Gates.** Typecheck, lint, tests, hidden tests, dependency and scope rules, and Visual QA
  (rendered screens at fixed widths and themes). All of them run in a sandbox.
- **Flow Studio dashboard.** A read-only dashboard over the run's event log: runs, tasks, gates,
  Lookback scorecards and the Automation view.
- **It improves itself.** Lookback scores every role after each run. It replays recorded tasks to
  test prompt and routing changes, and opens GitHub issues and pull requests for a human to
  review. It never merges anything it opened. Automatic UI pull requests carry before and after
  screenshots.
- **One binary.** `vtc` is a single Bun binary with the dashboard and both host plugins built in.
  `vtc install`, `vtc doctor`, `vtc config` and `vtc automation status` cover setup and health.

### Installing

Download the archive for your platform and `SHA256SUMS` from this release, then run:

```sh
sha256sum -c SHA256SUMS --ignore-missing   # or: shasum -a 256 -c SHA256SUMS --ignore-missing
tar -xzf vtc-0.1.0-<os>-<arch>.tar.gz
./vtc version
```

On macOS, a browser download of an unsigned binary is quarantined. Download with `gh release
download` or `curl` instead, which do not quarantine.

### Not yet

- **Signing.** The macOS binaries are not signed or notarized. An Apple Developer ID is needed
  only once other people install VTC, so it is skipped for now (owner decision H-11).
- **Publishing.** Nothing is published to Homebrew or a plugin marketplace.
- **Known gaps carried to the next round:**
  - Automatic UI pull requests show the first screen of each side, not a video of the changed
    flow.
  - Lookback routing proposals carry no tier replay evidence yet.
  - Token cost has not been calibrated on real runs.
