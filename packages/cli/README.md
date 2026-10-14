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

- `vtc lookback approve|pin|rollback --role <role> [--mode <mode>] --host <host>` moves Lookback's
  prompt pins in `~/.vtc/lookback/pins.yaml` for the repo it runs in (AD-21). `approve --version
<sha>` starts a canary once the version's replay result says `improve`, and promotes it when
  run again; `pin --version <sha>` pins a version outright; `rollback` ends the canary or moves the
  pin back to what it replaced. Every gesture is recorded in the file's history as a human's. No
  MCP tool or HTTP route writes the file, and a `pins.yaml` inside a repo is never read.
- `vtc merge-level restore [--level 1|2|3] [--reason <text>]` raises the merge level again after
  the engine lowered it (a revert or a red required base run), by appending a `restore` entry to
  the git-tracked `.vtc/merge-level.jsonl` (AD-23). Commit it so teammates share it. The engine
  never edits `project.yaml`.

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
executable's SHA-256. `vtc doctor` re-checks it. Projects with their own Playwright need none of
this; with no browser the visual gates are skipped with a visible reason. Playwright's installer
runs on `node` from `PATH` when vtc is the single binary.

## Codex plugin registration

`vtc install codex` also registers the compiled plugin per Codex's plugin layout: a marked copy
in `.agents/plugins/vtc/`, the local marketplace `.agents/plugins/marketplace.json` (merged into
one that exists) and `[plugins."vtc@<marketplace>"] enabled = true` in `.codex/config.toml`, in
the repo (project scope) or the home (user scope). The copy leaves out the plugin's MCP file: the
engine entry is already in `config.toml`.

## Releases

See `packaging/README.md` (AD-26): the release workflow, the installer, the Homebrew formula and
the pending macOS signing.
