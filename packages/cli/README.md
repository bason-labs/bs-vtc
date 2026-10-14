# @vtc/cli

The `vtc` command and the composition root (AD-1 rule 4, AD-19): it wires the engine, the host
adapters, the Gate Runner, the storage driver and the asset bundle, and it is what the single Bun
binary runs (AD-2, AD-20). Owner: the cli+binary team.

## Auto-resume

A run parked on a usage limit resumes at the reset time through one OS timer that runs
`vtc engine --wake-due` every minute (§6.9 step 4, spine §5 reading 59):

- macOS: a launchd agent; Linux: a systemd user timer.
- It is installed only by `vtc install --auto-resume` (never silently), and removed by
  `vtc install --no-auto-resume`. `vtc doctor` checks it.
- The daemon never runs `launchctl` or `systemctl`; it only writes its wake record to
  `~/.vtc/wake/<repo-key>.json`.

## Limitations in v1

- **Windows has no auto-resume timer** (D-aj, spine §5 reading 56). A run waiting for a usage
  reset resumes when the engine next runs on that repo (any `vtc` command or host session that
  starts it). `vtc install` and `vtc doctor` say so; `vtc install --auto-resume` fails there.
- **Who launches roles** (spine §5 readings 98 and 99): a Claude Code Lead's roles run as
  subagents of the Lead session (plugin-only, the default); a Codex Lead's roles run as headless
  Codex runs the engine launches. `hosts.dispatch: headless_allowed` also lets the engine resume a
  run headless after a usage reset with no Lead session, and run headless Claude roles.
- The Windows paths (`.cmd` shim execution, opening the dashboard URL) are unit-tested only.

## User settings

`~/.vtc/config.yaml` (`USER_CONFIG_FILE`) holds settings that belong to the person, never to a
repo. `env_passthrough` lists the credential variable names the detached daemon keeps (it drops
them by default, D-ak); `vtc doctor` shows which names pass. `gates.allow_unsandboxed: true`
lets gates run without an OS sandbox on a machine that has none (D-al); every such gate run
records an `unsandboxed_gate` incident. A repo's `.vtc/project.yaml` can set neither.
`research.search_provider` (H-3, spine §5 reading 156) names an optional keyed provider (`tavily`,
`exa`) for the `search` fetcher, with its key's variable in `research.api_keys.search`; there is
none by default, and then research search runs on the host's own web search in the Research
Analyst's session and no search key is kept or sent. `vtc doctor` says which.

Automatic issues and PRs (AD-27, contracts 5.0.0) read three user-level keys:

```yaml
upstream:
  repo: bason-labs/bs-vtc # VTC's own repo (the default)
  share: true # false: no upstream reports from any project (default true)
  checkout: /abs/path/bs-vtc # a local clone set up for VTC; absent: upstream issues only
automation:
  evidence_hosting: branch # or attach (gh >= 2.99.0 and a github.com remote)
```

A file that does not parse keeps upstream reports off. The project's own `upstream.share` and
`automation.{issues,prs,evidence}` live in `.vtc/project.yaml`, which the engine reads at the run's
commit. `vtc automation status [--json]` prints the repo's Automation report: whether issues, PRs
and upstream reports are on and why not, the open automatic issues and PRs with their links, and
the latest skips. `vtc pause` stops automation too.

## What `vtc doctor` reports since the wave-3 closing round

- Node 22.14 or later in development (D-bk, reading 165).
- **API-key billing** (D-bq, reading 171): a host whose `authStatus()` reports `billing: api_key`,
  and a Claude `apiKeyHelper` setup, warn with `API_KEY_BILLING_WARNING`. Role runs are allowed,
  so doctor does not fail on it.
- **User hooks and plugins** (D-bp, reading 170): headless Claude role runs pass
  `--setting-sources user`, so the hooks and enabled plugins in your Claude `settings.json` (and
  the plugins' own skills and hooks) run in them. Doctor lists them as a §7 accepted residual,
  bounded by the role's tools, every deny rule and the engine's write-scope check. It reads that
  one file, never the credentials beside it, and shows only hook commands (secrets redacted) and
  plugin names.
- **yt-dlp** (D-bs, reading 173): found on an absolute PATH entry outside the repo, or an `info`
  line saying YouTube transcripts are unavailable. VTC never installs it.
- **Research search** (H-3): an `info` line saying it uses the host's web search, or the keyed
  provider configured, which warns when its key variable is missing.

## What `vtc doctor` reports since round 4 (AD-27)

- **gh login**: `gh auth status`, its exit code only (no token is read, nothing it prints is kept).
- **evidence**: where PR media go: the orphan `vtc-evidence` branch (the default), or `gh
--attach` when `automation.evidence_hosting: attach`, gh is 2.99.0 or later and the origin
  remote is on github.com (it warns and falls back to the branch otherwise); and whether capture
  has vtc's pinned browser.
- **ffmpeg**: optional; without it GIF previews are off (`info`).
- **automation**: `automationFor` over `project.yaml`, `~/.vtc/config.yaml`, the origin remote and
  the gh login, with its notes.
- **billing**: a host billed through a cloud provider or gateway gets the neutral
  `PROVIDER_BILLING_NOTICE` (D-ci).
- **host web**: where research roles get web search (D-cf): Claude Code, else Codex with
  `web_search = "cached"`, else none (the engine's own fetchers, `HOST_WEB_OFF_NOTICE`).

`info` lines report and never fail. `vtc lookback pin|approve` warn when the target's agent is not
`editable_in_pack` on a host whose runs load the compiled agent (Claude Code): the version would
reach no run (reading 176). On Codex such a pin reaches headless runs only, which they note.

## Sandboxes

- **Gates** (D-al, spine §5 reading 69): every gate command runs in `sandbox-exec` (macOS) or
  `bwrap` (Linux), which the Gate Runner detects itself. `vtc doctor` reports which one is in
  use. It fails when there is none and the user has not opted in, and warns when the opt-in is on.
- **The Claude Code session** (D-an, readings 71 and 81): in plugin-only dispatch, every role runs
  inside your Lead session, so the engine runs them there only when that session's settings are
  on. `vtc install claude-code` shows the settings (the sandbox on, no unsandboxed retry,
  `failIfUnavailable` so Claude Code refuses to start rather than run commands unsandboxed, the
  VTC home and credential denies, and the same paths as `permissions.deny` `Read(//…)` /
  `Edit(//…)` rules, because the sandbox confines shell commands only and Claude's file tools
  follow permission rules), writes them into the repo's `.claude/settings.local.json` once you confirm at
  the terminal, dropping the local entries that let commands past the sandbox, and makes git ignore
  that file through the repo's `info/exclude`. The sandbox counts as on only when nothing widens
  it in the local file, the repo's committed `.claude/settings.json` or your own Claude
  `settings.json` (`excludedCommands`, an allow entry reaching the VTC home,
  `filesystem.disabled`, `network.allowAllUnixSockets`, `enableWeakerNestedSandbox`), and when the
  machine has what Claude Code's sandbox needs (Seatbelt; `bwrap` and `socat` on Linux). The
  bridge reads the state afresh for every hello to the engine, so a mid-session edit counts;
  `vtc doctor` shows it and anything missing or widening it. Managed settings, `--settings` and
  `--setting-sources` are beyond what VTC reads (spine §7).
- **Human-only tools** (`approve`, `answer`, `change_request`): the cli's engine client refuses
  them. The install token goes into a hello only after you confirm at an interactive terminal
  (`human-channel.ts`). No cli command calls these tools today. `vtc resume --run <id> --adopt`
  (continue a run another clone started, reading 88) goes over the same confirmed connection.

## Outside a git repository

`vtc engine --mcp` answers `initialize`, `ping` and `tools/list` itself and returns "not in a git
repository: run git init, then vtc init" for every tool call (reading 74). It creates nothing
and starts no daemon. Malformed `vtc statusline-tee` arguments show
`vtc: statusline misconfigured — run vtc doctor` as the statusline and exit 64 (reading 76).

## Human gestures at the terminal

Some decisions are a human's alone, so their commands write a file directly after a yes typed at
an interactive terminal (an agent's shell or a pipe cannot confirm), like `vtc calibrate`
(readings 43, 103 and 104). Without a terminal they print what they would do and exit 3.

- `vtc lookback approve|pin|rollback --role <role> [--mode <mode>] --host <host> [--reason <text>]`
  moves Lookback's prompt pins in `~/.vtc/lookback/pins.yaml` for the repo it runs in (AD-21).
  The pins are this machine's: since D-cb (reading 196) an `improve` verdict opens a bs-vtc PR on
  its own, and the human's merge of that PR is the promotion for everyone.
  `approve --version <sha>` starts a local canary once the version's replay result says `improve`
  (recomputed from its trials with the shared `replayVerdict`; the file's own verdict and sign
  test must agree with it, since roles can write the repo), and promotes it when run again; `pin --version <sha>` pins a version outright; `rollback` ends the canary or moves the
  pin back to what it replaced. Every gesture is recorded in the file's history as a human's,
  with the redacted `--reason`. No
  MCP tool or HTTP route writes the file, and a `pins.yaml` inside a repo is never read.
- `vtc merge-level restore [--level 1|2|3] [--reason <text>]` raises the merge level again after
  the engine lowered it (a revert or a red required base run), by appending a `restore` entry to
  the git-tracked `.vtc/merge-level.jsonl` (AD-23). Commit it so teammates share it. The engine
  never edits `project.yaml`. The ledger is never read through a symlink, its text is shown with
  control characters escaped, and if the engine appends to it while you decide, nothing is written
  and you run the command again (a restore must not clear a downgrade you did not see).

## Level 3 and research (contracts 4.5.0)

The daemon gets two more services from the cli (AD-19 rule 2):

- **`remoteMerge`**, the user's own `gh` (`gh-remote-merge.ts`): the Level-3 preflight reads the
  remote, `gh auth status` and the base branch's rules, classic protection and merge settings,
  and never changes them; auto-merge is enabled only with `--match-head-commit <gated sha>`;
  every argv is checked against `GH_FORBIDDEN_ARGS` (`--admin`) before it runs; the post-merge
  watch reads the merge commit's check runs and statuses and looks for reverts. `vtc doctor`
  runs the same preflight in a VTC repo whose `merge_level` is 3 and says what to configure.
- **`http`**, the research fetchers' client (`http-client.ts`): HTTPS only, every hop's DNS answer
  checked with `isPrivateAddress`, redirects followed by hand, no cookies, a fetcher's key never
  sent to another origin, one deadline and a byte cap. It needs a resolver: the binary uses Bun's;
  Node in development has none among the runtime-safe built-ins, so there the fetchers are
  unavailable and new facts stay UNVERIFIED.

## The visual stack's browser

`vtc doctor --install-browser` (explicit only, D-ay) installs `playwright-core`, `axe-core`,
`pixelmatch` and `pngjs`, each pinned by version and verified by its npm integrity before it is
unpacked, into `~/.vtc/browsers/`, runs Playwright's installer for the headless shell with
`PLAYWRIGHT_BROWSERS_PATH` set there, and writes the `BrowserPin` (`browsers/pin.json`) with the
executable's SHA-256. `vtc doctor` re-checks it. A re-run skips a package whose files still match
the tree hash recorded at its verified install; that catches drift, not tampering, since the
record lives in the same user-writable store. Projects with their own Playwright need none of
this; with no browser the visual gates are skipped with a visible reason. Playwright's installer
runs on `node` from `PATH` when vtc is the single binary (so `--install-browser` needs Node.js
there), with an allowlisted environment: no credential variable and no `PLAYWRIGHT_*` override
reaches it.

## Codex plugin registration

`vtc install codex` writes no Codex plugin registration of its own. Registering the plugin
(`.agents/plugins/marketplace.json`, `[plugins."vtc@<marketplace>"]`) is `HostAdapter.install`'s
job (AD-6, AD-16 rule 4), so every file it writes passes the adapter safety contract; until the
spine's "Codex plugin manifest fields" row closes, the install places the skills and registers no
hooks (§5 reading 94).

## Releases

See `packaging/README.md` (AD-26): the release workflow, the installer, the Homebrew formula and
the pending macOS signing.
