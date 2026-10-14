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
   stuck loops, and security findings in VTC's own dependencies.
2. **It proposes.** For a role with enough attributed failures, the lookback role proposes at most
   three changes to the editable part of that role's prompt. It can also propose a new specialist
   role, a new engine tool for a script that keeps recurring, a change to caps, budgets or
   routing, or a capability users keep asking for.
3. **It tests the proposal.** A replay runs recorded tasks again with the current prompt and with
   the proposal, a few times each, in clean checkouts, and grades both with the same gates (or, for
   a verdict role such as the Spec Verifier, against what really happened). A sign test and an
   A/A noise floor decide whether the change is a real improvement.
4. **It opens an issue and a pull request.** For VTC's own repo (`bason-labs/bs-vtc` by default),
   an improvement becomes a draft PR on a `vtc/auto/<kind>/<id>` branch. A prompt change edits the
   role's prompt and adds a `roles/CHANGELOG.md` entry with the hypothesis, the evidence and the
   evaluation. A defect gets an issue, and when the fix is clear VTC runs its own pipeline on a
   local bs-vtc checkout to build the fix PR. Problems VTC finds in your project's app (a parked
   task it cannot resolve, a CI failure after merge, a reverted change, an out-of-scope finding)
   become issues in your project's repo, and a fixable one becomes a normal VTC run with its usual
   draft PR.
5. **It shows its evidence.** Every automatic PR carries a recording of the dashboard replaying
   the run that produced it, key screenshots, and, by kind, before and after screenshots, the
   scorecard and replay charts, or the gate report and test results. Every frame is redacted
   before it leaves your machine.
6. **A human decides.** You review and merge. Merging a Lookback PR is what promotes a prompt for
   everyone, in the next VTC release; `vtc lookback approve` still lets you try a candidate on one
   machine first.

What keeps this safe and quiet:

- **Privacy.** Reports to VTC's own repo carry VTC-side data only: role, host, model, prompt
  version, metrics, error class and VTC stack frames. They never carry your code, file paths,
  repo or client names, or prompts filled with your project's content, and everything passes
  VTC's secret redaction. Turn it off for one project with `upstream.share: false` in
  `.vtc/project.yaml`, or for all of them in `~/.vtc/config.yaml`.
- **Noise control.** One issue per problem (a recurring one gets a comment instead of a
  duplicate), at most 5 new issues a day per repo, 3 open automatic PRs per kind and 1 open
  Lookback PR per role. Issues that stop recurring close themselves after 14 days. Label an issue
  `vtc:muted` and VTC never raises it again, or `vtc:keep` to keep it open.
- **Control.** Automation is on when your project has a GitHub remote and `gh` is logged in, and
  off with a visible note otherwise. `vtc pause` stops it. The dashboard's Automation view lists
  every issue and PR VTC opened, and what it skipped and why; the Lead gives you a daily summary.
