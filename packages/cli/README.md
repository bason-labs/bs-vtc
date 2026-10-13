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
- Engine-driven resume also needs `headless_allowed` (spine §5 reading 12).
- The Windows paths (`.cmd` shim execution, opening the dashboard URL) are unit-tested only.

## User settings

`~/.vtc/config.yaml` (`USER_CONFIG_FILE`) holds settings that belong to the person, never to a
repo. `env_passthrough` lists the credential variable names the detached daemon keeps (it drops
them by default, D-ak); `vtc doctor` shows which names pass. A repo's `.vtc/project.yaml` cannot
set it.
