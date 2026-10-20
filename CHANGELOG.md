# Changelog

All notable changes to `vtc` are listed here. Versions follow semver; while the version is 0.x,
any release may change behaviour. Role prompt changes have their own log in `roles/CHANGELOG.md`.

## Unreleased

- **The Security agent can write its threat model.** In the design step it could not save its
  threat model file, so the step failed. It may now write that one file and nothing else.
- **Empty fields in an agent's answer no longer fail it.** An agent that left an optional field
  empty (`null`) had its whole answer rejected. Those fields are now treated as not filled in.
- **More ways of writing a requirement are recognised.** Requirements written as
  `**REQ-4** (revised)`, with the separator inside the bold, with a bold title, or named only by
  their acceptance criteria are now found in the specification.
- **References the agents really write are accepted.** A reference to the specification by file
  path and anchor, and a role's own instructions given by a relative path, no longer get a result
  rejected.
- **Headless Codex agents get the design and research methods.** The method skills a role's prompt
  names are now available to it when it runs headless, as they are under Claude Code.
- **A rejected answer is fixed in the same agent session.** Instead of starting a new session and
  re-reading everything, the agent that was rejected is asked to fix its answer where it is, which
  costs less.

## v0.2.5 (2026-10-17)

- **Autopilot: hand VTC the task, review the PR.** Start a run with `/vtc start --autopilot "…"`
  (Claude Code: `/vtc:vtc start --autopilot "…"`; Codex: `$vtc start --autopilot "…"`), or put
  `autopilot: true` in `.vtc/project.yaml` for every run. VTC then answers the roles' questions
  with their recommended option and approves the specification and design itself, and the
  Lead keeps going instead of stopping to report that it is waiting. The PR lists every decision
  VTC took and the files it approved, so you review them all there. It still stops for what it
  must never decide alone: spending more than the budget, a security or dependency rule, a fix
  that keeps failing, an expired login, or an answer that would drop or waive work. It never
  merges into your main branch: the PR waits for you. `vtc status` shows "Autopilot: on" and how
  many decisions it took.
- **No more "who should have caught it?" question.** The Lead now suggests the answer next to
  each question (usually "none"), and you only correct it if you disagree.
- **`vtc update` updates VTC in one command.** It finds the newest release, asks you, downloads
  and checks it against `SHA256SUMS`, waits if a role is still running (`--wait`), stops the
  engines, swaps the binary (keeping the old one as `.vtc-<old>.bak`) and refreshes the Claude Code
  and Codex plugins in your repos. Then open a new chat. `--check` only reports; `vtc doctor`
  says when an update is available (checked at most once a day).

## v0.2.4 (2026-10-17)

- **A quick fix's design step gets the specification.** A quick fix approves the requirements and
  the design together on one screen, so its specification is not approved yet while the Architect
  and Security work. They were sent no specification at all and stopped to ask for one. They now
  get the Business Analyst's specification; its open questions still wait for you on that screen.
- **Roles may cite their own instructions file.** Each role cited the task pack it was given, and
  VTC rejected the result because that file is outside the role's working folder, so every design
  role ran twice. Such a citation now counts, and roles are told to cite files by their path
  in the working folder.

## v0.2.3 (2026-10-17)

- **Advisors work when your Lead is Codex.** Asking the Lead for an advisor (the incident
  debugger, the estimator and the others) failed every time under Codex: VTC handed the advisor
  back to the Lead to run inside its own chat session, which VTC never allows on Codex. Now the
  advisor runs in the background as a headless Codex run, like every other role, and the Lead
  tells you its answer as soon as it comes back (the whole answer is kept in
  `.vtc/state/results/`). It still counts against the run's advisor budget. Nothing changes with
  a Claude Code Lead.
- **`vtc cancel` ends a run started by mistake.** A repo runs one VTC run at a time, and until now
  a run could only be paused, never ended, so a run started in the wrong repository blocked the
  next one. `/vtc cancel` (Claude Code: `/vtc:vtc cancel`; Codex: `$vtc cancel`) asks you to
  confirm in the chat; `vtc cancel` asks at the terminal. The run ends as aborted, its role runs
  stop, its automatic merges are turned off and its open questions close; its worktrees and
  branches stay for you to keep or remove. A role can never cancel a run.

## v0.2.2 (2026-10-17)

- **Codex roles can read your code again.** v0.2.1 gave Codex roles their full instructions, and
  those told a read-only role to "run no shell command". Claude Code has file tools for that;
  Codex does not, so a Codex role could not open its own task pack and parked asking for a file
  reader. A Codex role now reads and searches with read-only shell commands (`cat`, `sed -n`,
  `rg`, `ls`, `git show`), inside its sandbox (read-only, network off); it still writes only inside
  its Write scope. Claude Code roles are unchanged.
- **VTC's daily scan of its own dependencies works.** It wrote its report where the sandbox's
  check phase may not write (since v0.2.0 that phase has its own empty home), so every scan failed
  and showed "automation could not scan VTC's own dependencies". The report now stays in the
  scan's own folder.

## v0.2.1 (2026-10-17)

- **Codex roles know what to return.** A role run by `codex exec` now gets its whole compiled
  instructions (its contract and how to return its result), not only its role text, and a
  result schema made for its dispatch: no task, mode or feature it was not given, only the
  artifact types and exits its role declares. A rejected result says what was expected ("this
  dispatch has no task (send task null)", "allowed: spec"), never "undefined".
- **Usage limits on Codex resume on time.** When Codex stops a role at its usage limit, VTC now
  reads which window was hit and when it resets (from Codex's rate-limit data, or the "try again
  at 4:00 PM" time in your local zone) and schedules the resume for then, instead of retrying
  every 15 minutes. Only the limit that actually stopped the turn counts, so a stale window of
  another limit never brings the resume forward.
- **Lighter role runs.** Every role is told its context budget, that its pack lists every input
  there is, and to read code by line range, not whole files; a quick fix's specification is
  kept short. Packs of steps that change no code no longer list the gate commands.
- **Screenshots in a request.** `start` and `change_request` take image attachments (file
  paths). VTC keeps private copies in its local state (`.vtc/state/attachments/`), never
  committed, pushed or added to PR evidence, and gives them to the roles that write the
  specification; a change request's screenshots also go to the role that owns what changes
  (the Architect, the Designer, or the task whose interface contract changes). If your Lead's
  app does not give it the paths of pasted images, the Lead says so and asks you to describe
  them or attach the files.
- **Your Claude Code statusline is yours (H-10).** `vtc install claude-code` no longer wraps
  your statusline in `vtc statusline-tee`. Only `vtc install claude-code --statusline` does,
  after asking you at the terminal, and never twice. `vtc install claude-code --no-statusline`
  puts back the command an earlier install wrapped.
- **Shorter sandbox messages.** `vtc doctor` says how many session sandbox deny rules are missing
  with at most five examples, and `vtc install claude-code` shows the settings file and how
  many entries each list adds. `--verbose` on either prints every entry.
- **`vtc status` with no budget yet.** Before a run has any feature budget (a quick fix's first
  steps) it shows "Spent: $2.59 (no cap)" instead of "Budget: $2.59 of $0.00".
- **Plugin version.** The Claude Code and Codex plugins now carry the vtc version (they said
  0.1.0 before), and `vtc install codex` prints it.
- **Gitignored VTC settings are flagged.** `vtc doctor` and `vtc init` warn when `.gitignore`
  keeps `.vtc/project.yaml` or `.vtc/gates.yml` out of git (for example a `.vtc/` line), name
  the line, and say to ignore only `.vtc/state/` instead: a run starts only on the committed
  copies of those two files.
- **Quieter run log while paused.** Usage readings are logged only when a value really changes,
  and at most once an hour while the run is paused or waiting for a limit to reset.

## v0.2.0 (2026-10-16)

- **Screenshots work on macOS.** The pinned Chromium now starts inside the gate sandbox on
  macOS, so Visual QA and before/after evidence work on a Mac. Only the browser runner gets three
  extra sandbox rules (Chromium's own process rendezvous and the power-management client); no
  file, network or credential access was added.
- **`vtc doctor --install-browser` works again.** It failed for everyone because one pinned
  package (pngjs 7.0.0) ships a folder without its execute permission; files are now given normal
  permissions after unpacking, as npm does.
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
- **Check tools that install scripts cannot replace (H-14).** Every file of the checkout and of
  every dependency tree (`node_modules`, `.yarn`, Python virtual environments, the Go and Cargo
  download caches) is hashed after an install that runs no lifecycle script, and again after the
  scripts and before each check gate. So it does not matter how a gate runs its tools (`turbo`,
  `pnpm -r`, `make`, `tox`). Anything that changed fails the gates as tampering. Install scripts
  run one package at a time; a package may only add files to its own directory or replace its
  native binaries (esbuild), shown as a warning. Two registry versions of one package
  (esbuild 0.21 beside 0.25) are fine. Also failing closed: committed dependency trees, files the
  check cannot read, links to places install scripts can write, and new package-manager or test
  configs (`.npmrc`, `pnpm` settings, Babel, SWC, pytest). Check gates get a fresh empty home.
  Installs with no scripts-free form (Yarn, `npm install`, `uv sync`) still run, with a warning.
  `vtc calibrate` explains each failure and what to change. Hashing adds about 2 seconds per GiB.
- **Routing changes are replayed before they are proposed (D-cn).** When the weekly window and
  budget allow it, RETRO re-runs a proposed routing change's held-out tasks on the current and the
  proposed start tier, and the change is proposed only once that replay backs it.
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
