# Changelog

All notable changes to `vtc` are listed here. Versions follow semver; while the version is 0.x,
any release may change behaviour. Role prompt changes have their own log in `roles/CHANGELOG.md`.

## Unreleased

- **No price table to fill (H-12).** A host that reports no cost (Codex) ships its default
  prices with vtc, from the provider's public API pricing page with that page's URL and date.
  `prices` in `~/.vtc/config.yaml` now only overrides a model, and never has to be set.
  `vtc doctor` shows each shipped table's source and date and your overrides. It warns only when
  such a host has no known price at all, and no longer asks you to fill the table.
- **Refused model ids (D-cx).** When a host refuses a model id on your plan, the run falls back
  to the host default. `vtc doctor` lists each refused id with its last time and the host's
  message.
- **Release notes from this file (H-16).** The release workflow takes each release's notes from
  its section here, checks the section exists before building, and publishes only to the
  private repository's GitHub Releases.
- **Design gaps are fixed before G2 (H-13).** When the design leaves an approved requirement
  without an architecture decision, a component or (for UI) a screen, the Architect and the
  Designer are sent the gaps and fix them, up to 3 rounds, before G2 is shown. A loop that is
  stuck or hits the cap parks and names the uncovered requirements. There is no "approve anyway".
  The dashboard shows each coverage check before G2.
- **Check tools that install scripts cannot replace (H-14).** Lint, typecheck and test tools run
  from a pinned copy or are verified by content hash after an install that runs no lifecycle
  script. A tool that an install script changed, including an interpreter or shell tool planted
  beside it and the plugins its lint config loads, fails the gate as tampering. `vtc calibrate`
  records each gate's tool and replaces one that went stale. A tool that could only be hashed
  after an install's own scripts ran is marked as such.
- **Reviewers start on their own tier (D-cu).** Difficulty routing picks the start tier of the
  engineers and the QA author only. A task that starts on the lowest tier moves up after every
  failed round (D-cv).
- **The changed flow on automatic UI pull requests.** The Designer writes the app's key journeys to
  `.vtc/design/flows.yaml`, and an automatic UI pull request records the journey its change
  touches on both sides, instead of only the first screen.
- **Costs you can read.** A run on a model with no known price shows "Cost unknown" next to what
  the budget counted for it, for failed and rejected runs too. A run whose model the host refused
  shows that it ran on the host default, or that the default was refused too.

### Known gaps

- Routing proposals that a tier replay should back are held back until the engine can run tier
  replays; the others carry the scorecard alone.
- Token cost has not been calibrated on real runs.
- Codex's usage-limit message has not been recorded yet.

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
