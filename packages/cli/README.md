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
- **The engine launches no headless host runs in v1** (spine §5 reading 93): `headless_allowed`
  behaves as `plugin_only`, a host without subagents pauses its run, and cross-family review is
  skipped. The auto-resume timer wakes the engine at the reset; the run continues when the Lead
  session calls `next`.
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
- **The Claude Code session** (D-an, reading 71): in plugin-only dispatch, code-running roles run
  inside your Lead session, so the engine runs them there only when that session's sandbox is on.
  `vtc install claude-code` shows the settings (the sandbox on, no unsandboxed retry,
  `failIfUnavailable` so Claude Code refuses to start rather than run commands unsandboxed, and the
  VTC home denies), writes them into the repo's `.claude/settings.local.json` once you confirm at
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
  (`human-channel.ts`). No cli command calls these tools today.

## Outside a git repository

`vtc engine --mcp` answers `initialize`, `ping` and `tools/list` itself and returns "not in a git
repository: run git init, then vtc init" for every tool call (reading 74). It creates nothing
and starts no daemon. Malformed `vtc statusline-tee` arguments show
`vtc: statusline misconfigured — run vtc doctor` as the statusline and exit 64 (reading 76).
