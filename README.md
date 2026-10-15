# VTC (Virtual Tech Company)

VTC runs a small software company on your machine: a Lead you talk to in Claude Code or Codex,
and a team of role agents (business analyst, architect, designer, engineers, QA, reviewers and
others) that take an idea through spec, design, build, gates and review to a pull request. A local
engine decides what runs next, checks every result against frozen contracts and gates, and keeps
an event log you can watch in the Flow Studio dashboard. VTC uses your own Claude Code and Codex
logins and your own `gh` login. It never handles an API key or a token, and it never bypasses a
host's permission prompts.

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
   in VTC's repo. So does a run in which three or more tasks of one size ran out of budget, or
   three or more tasks hit their fix-round cap: VTC's defaults may need changing. Once a day VTC
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

Not yet available (each is an owned followup in the spine, §5 readings 215 and 216):

- Before and after screenshots of a UI change, and a video of the changed flow. Until the gate
  runner can render the base commit, a UI PR is labelled `evidence: partial`.
- Issues and PRs for a new engine tool, a routing change or a missing capability. Nothing
  produces these signals yet.
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
