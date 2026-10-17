# VTC (Virtual Tech Company)

**VTC is a small software company that lives on your machine.** You describe what you want in
Claude Code or Codex. A Lead agent turns it into a run, and a team of role agents builds it:

```
 you ──► Lead ──► Business Analyst ──► G1: you approve the requirements
                                            │
                  Architect + Designer ◄────┘
                          │
                          ▼
                  G2: you approve the design
                          │
                  Planner ──► Engineers ──► Gates (typecheck, lint, tests, security, Visual QA)
                                  ▲               │ fail: fix loop (capped)
                                  └───────────────┘
                                          │ pass
                                  Reviewers ──► Final Review ──► pull request for you
```

- **Your subscription, your logins.** VTC runs on your own Claude Code or Codex plan and your `gh`
  login. It never asks for an API key and never skips a permission prompt.
- **You stay in charge.** You approve the requirements (G1) and the design (G2), and you merge the
  pull request. Anything stuck stops and asks you.
- **Checked, not trusted.** A local engine decides what runs next, checks each agent's result
  against fixed contracts, and runs real gates in a sandbox before anything reaches a PR.
- **You can watch it.** `vtc dashboard` opens Flow Studio: runs, tasks, gates, costs.
- **It gets better.** After each run, Lookback scores every role and proposes prompt fixes as pull
  requests to this repo, for a human to review.

## Quick start

### 1. Install `vtc` (once per machine)

Download the archive for your platform from
[Releases](https://github.com/bason-labs/bs-vtc/releases), check it, and put `vtc` on your PATH:

```sh
gh release download v0.2.1 -R bason-labs/bs-vtc -p 'vtc-0.2.1-darwin-arm64.tar.gz' -p SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
tar -xzf vtc-0.2.1-darwin-arm64.tar.gz && mv vtc ~/.local/bin/
vtc version
```

Then install the host plugins and the tools the gates use:

```sh
vtc install codex                 # the Codex plugin
vtc install claude-code           # the Claude Code plugin
vtc doctor --download --install-browser   # pinned scanners and the screenshot browser
vtc install --auto-resume         # optional: continue runs after a usage limit resets
```

Restart Claude Code and Codex afterwards.

### 2. Set up a project (once per repo)

```sh
cd ~/code/my-app
vtc init                  # creates .vtc/project.yaml
vtc calibrate             # detects build/test/lint commands; you confirm them
vtc install claude-code   # writes this repo's Claude session sandbox; you confirm it
vtc doctor                # should end with "vtc is ready."
git add .vtc/project.yaml .vtc/gates.yml .gitignore && git commit -m "Set up VTC"
```

In `.gitignore`, ignore only `.vtc/state/` (VTC's local state), never the whole `.vtc/` folder:
a run starts from the committed `.vtc/project.yaml` and `.vtc/gates.yml`.

### 3. Kick off work

Open Claude Code or Codex **in the project folder** and talk to the Lead:

| You want to                    | Claude Code                               | Codex                       |
| ------------------------------ | ----------------------------------------- | --------------------------- |
| Fix a bug / small change       | `/vtc start "Fix: autoplay skips song 2"` | `$vtc start "Fix: ..."`     |
| Build a feature                | `/vtc start "Add playlist sharing"`       | `$vtc start "Add ..."`      |
| Continue after a break         | `/vtc continue`                           | `$vtc continue`             |
| See where things are           | `/vtc status`                             | `$vtc status`               |
| Answer what is waiting for you | `/vtc escalations`                        | `$vtc escalations`          |
| Change something mid-run       | `/vtc change "Use tabs, not a modal"`     | `$vtc change "..."`         |
| Stop / restart everything      | `/vtc pause`, `/vtc resume`               | `$vtc pause`, `$vtc resume` |

In Codex, `$vtc` calls the plugin's `vtc` skill (type `$` and pick it from the list). You can
also just say "use vtc to fix ...".

The Lead classifies your request as a `quick_fix`, a `feature` or a `new_project` and tells you
which; you can change it. Then it runs the loop and stops for you at G1, G2, and anything that
needs a decision. Attach screenshots as files and the Lead passes them to the roles that need
them (kept private in `.vtc/state/`).

From a terminal at any time: `vtc status`, `vtc dashboard`, `vtc pause`, `vtc resume`.

### Which host runs the roles?

- **Claude Code Lead:** role agents run as subagents of your Claude Code session.
- **Codex Lead:** role agents run as headless `codex exec` runs that the engine starts.

Both count against your own plan. Models are picked by task difficulty (small tasks on the
cheaper tier, risky ones on the top tier); `vtc config` shows the table.

## Learn more

- Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- Design: [`docs/superpowers/specs/2026-10-12-vtc-system-design.md`](docs/superpowers/specs/2026-10-12-vtc-system-design.md)
- Architecture (binding): [`docs/architecture/vtc-spine.md`](docs/architecture/vtc-spine.md)
- Who owns what: [`tooling/ownership.json`](tooling/ownership.json)

## Repository layout

| Path                | What it is                                                                |
| ------------------- | ------------------------------------------------------------------------- |
| `packages/shared`   | Frozen contracts: Zod schemas, JSON Schemas, interfaces, pure helpers     |
| `packages/engine`   | The deterministic engine: state, gates, git, Lookback, research, upstream |
| `packages/adapters` | Claude Code and Codex host adapters                                       |
| `packages/compiler` | Compiles the neutral role sources into each host's plugin                 |
| `packages/cli`      | The `vtc` command and the single Bun binary                               |
| `apps/dashboard`    | Flow Studio, the read-only dashboard                                      |
| `roles`, `skills`   | Role prompts and contracts, skill packs                                   |
| `gates`, `fixtures` | Gate defaults and pinned tools, golden runs for tests                     |
| `docs`, `tooling`   | The spine, research notes, architecture and ownership checks              |

## Development

Node 22.14 or later and pnpm 10. Bun 1.4.3 builds the single binary.

```sh
pnpm install
pnpm verify          # typecheck, lint, dependency rules, tests, format, build
pnpm verify:scope <team> --base build/foundation
```

## How VTC improves itself

VTC watches its own work and turns what it learns into GitHub issues and pull requests that a
human reviews (spine AD-27). It never merges anything it opened on its own.

1. **It notices.** At the end of each run (RETRO), Lookback scores every role from the event log:
   pass rates, review rounds, escalations, tokens and cost. The engine also records VTC's own
   defects: engine incidents, gate infrastructure errors, adapter parse failures, crashes and
   stuck loops. A crash keeps the stack frames that lie in VTC's own code, which locate it. Each
   recurring defect, and each cost regression against a role's previous prompt, becomes an issue
   in VTC's repo, and so does a version that got worse than its own runs 14 days earlier (a model
   or host update). So does a run in which three or more tasks of one size ran out of budget, or
   three or more tasks hit their fix-round cap: VTC's defaults may need changing. A shell command
   shape (the program, its subcommand and its flag names, never a value; the lines of a
   here-document are never read as commands) that roles ran in three or more tasks, and a missing
   capability named on two or more escalations, become tool and capability issues; only a common
   developer tool's name leaves your machine, so your own scripts stay local. Lookback also scores
   each start tier by task size and risk, and a start tier that keeps escalating, or a cheaper one
   that does as well, becomes a routing issue. Its PR may change only the routing table's file:
   VTC checks the changed files with git and opens no PR that touches anything else. Once a day VTC
   also scans its own dependencies (the lockfile it was built from) offline with osv-scanner,
   against the database `vtc calibrate` downloads, and each advisory becomes a security issue.
2. **It proposes.** For a role with enough attributed failures, the lookback role proposes at most
   three changes to the editable part of that role's prompt. When failures keep landing in a
   discipline that no specialist serves, or escalations keep naming a role VTC does not have,
   Lookback also raises a "new agent" issue.
3. **It tests the proposal.** A replay runs recorded tasks again with the current prompt and with
   the proposal, a few times each, in clean checkouts. A role that writes files is graded by the
   same gates. The Spec Verifier, which only gives verdicts, is graded against what really
   happened to the work it judged. A sign test and an A/A noise floor decide whether the change
   is a real improvement.
4. **It opens a pull request.** A replay that shows an improvement becomes a PR to VTC's own repo
   (`bason-labs/bs-vtc` by default) on a `vtc/auto/<kind>/<id>` branch. The PR edits the role's
   prompt and adds a `roles/CHANGELOG.md` entry with the hypothesis, the evidence and the
   evaluation. VTC opens it only when your copy of that prompt is the one the replay measured, so
   a PR never undoes a change that was merged since.
5. **It fixes what it can.** Problems VTC finds in your project's app (a parked task it cannot
   resolve, a CI failure after merge, a reverted change, an out-of-scope finding, Final Review
   leftovers) become issues in your project's repo. A fixable one (anything but a parked task)
   then becomes a normal VTC run, with the issue as its spec. The run starts once the current run
   has finished, and it opens a draft PR on its `vtc/auto` branch. Issues VTC works on itself
   are labelled `vtc:fixable`. For VTC's own repo the same happens on the bs-vtc checkout set as
   `upstream.checkout` in `~/.vtc/config.yaml` ("VTC builds VTC"): a crash VTC located in its own
   code, an advisory in VTC's dependencies (the PR bumps the dependency), a new-agent issue (the
   run builds the role with the new-role scaffold, and its PR is labelled `needs-eval`) and a
   change to its defaults. The checkout's VTC also picks up these issues when another of your
   projects raised them, and starts their runs one at a time. A defect without VTC stack frames
   (a parse failure, a stuck loop) stays an issue for a human.
6. **It shows its evidence.** Every automatic PR carries a recording of the dashboard and key
   screenshots. A PR caused by your project's run shows only a VTC-side view: the scorecard and
   replay charts, with tasks numbered rather than named. Any other PR shows the run that produced
   it, and a non-UI fix also shows its gate report. Every frame is redacted before it leaves your
   machine. A capture that shows an empty page fails, and a PR with no evidence is never opened.
7. **A human decides.** You review and merge. Merging a Lookback PR is what promotes a prompt for
   everyone, in the next VTC release; `vtc lookback approve` still lets you try a candidate on one
   machine first.

Not yet available (each is an owned followup in the spine, §5 readings 215, 216, 231 and 232):

- A video of the changed flow in a UI PR. An automatic run's UI PR shows before and after
  screenshots of the commit its branch was cut from and of its head, but its flow video shows the
  first screen only until flows can be scripted.
- Replay evidence for a routing change (the same prompt run on two start tiers). A routing issue
  carries the routing scorecard as its evidence.
- Resuming a replay that a limit stopped partway. It starts again from the beginning at the next
  RETRO.

A fix for VTC's own repo runs only on a bs-vtc checkout. Until VTC runs on one, its issues wait
there for a human.

What keeps this safe and quiet:

- **Privacy.** Reports to VTC's own repo carry VTC-side data only: role, host, model (a public
  model name, or `custom` for a cloud inference profile or gateway alias), prompt version,
  metrics, error class and VTC stack frames. They never carry your code, file paths,
  repo or client names, or prompts filled with your project's content, and everything passes
  VTC's secret redaction. Turn it off for one project with `upstream.share: false` in
  `.vtc/project.yaml`, or for all of them in `~/.vtc/config.yaml`.
- **Noise control.** One issue per problem (a recurring one gets a comment instead of a
  duplicate), at most 5 new issues a day per repo, 3 open automatic PRs per kind and 1 open
  Lookback PR per role. Issues that stop recurring close themselves after 14 days. Label an issue
  `vtc:muted` and VTC never raises it again, or `vtc:keep` to keep it open.
- **Control.** Automation is on when your project has a GitHub remote and `gh` is logged in, and
  off with a visible note otherwise. VTC checks the login with `gh auth status` when it starts
  and every hour, and never reads a token. `vtc pause` stops it. The dashboard's Automation view lists
  every issue and PR VTC opened, and what it skipped and why, including what it did between
  runs; the Lead gives you a daily summary.
