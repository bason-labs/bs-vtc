# gates/

Gate definitions, scanner pins and MIT rulesets (spec §4.4, §7). Owned by the gate-runner team
(AD-15). The Gate Runner itself lives in `packages/engine/src/gates/`.

- `scanners.json` (validated by `ScannerPinsSchema` in `@vtc/shared`): each scanner pinned by
  version, an https download URL template and a SHA-256 **per platform**, copied from the
  release's published checksums. The same pins are embedded in the binary
  (`packages/engine/src/gates/scanner-pins.ts`, which also maps each platform to the release's
  asset name); a test keeps the two equal. Scanners are downloaded on demand into
  `~/.vtc/scanners/<name>/<version>/<platform>/`, verified against the pin before anything is
  unpacked, and re-verified before every use against `binary_sha256`, the pinned SHA-256 of the
  extracted executable (D-ap, spine §5 reading 73), never against the `vtc-scanner.json` manifest
  beside it. For a raw binary download it equals `sha256`; for an archive it was computed from the
  verified archive. A platform pinned without `binary_sha256` is downloaded and verified against
  `sha256` again before each use. Never auto-updated (§7.2, §15).
  - Gitleaks 8.30.1 (MIT), osv-scanner 2.6.0 (Apache-2.0, always run with `--offline`),
    Opengrep 1.30.1 (LGPL-2.1, downloaded on demand, SHA-verified and run only as a separate
    program; spine §5 reading 40), Checkov 3.3.20 (Apache-2.0).
  - Checkov publishes no darwin-arm64 build and VTC pins no Rosetta one (spine §5 reading 41).
    There it is user-installed: the store rejects it with `ScannerUnavailableError`, `vtc doctor`
    warns, and the Gate Runner runs the user's own `checkov` from an absolute `PATH` entry outside
    the repo (never a relative entry or a file in the repo or a checkout, which a diff controls;
    evidence notes that it was not SHA-verified). When there is none, the L4 IaC gate is `skipped`
    with a visible `skipped_reason`. Every other platform keeps its pin. Only Checkov falls back
    this way (`USER_INSTALLED_SCANNERS`, spine §5 reading 75): any other pinned scanner with no
    build for the platform reports `error` / `infra`, even when the user has their own copy.
  - diff-cover (L3) is a Python package with no per-platform binary, so it is not pinned here: a
    project that wants L3 installs it, writes the gate into `.vtc/gates.yml` by hand and confirms
    the command like any other (calibrate does not detect it yet, see below).
- Pinned scanners pass the allowlist by name, so their arguments are checked instead
  (`packages/engine/src/gates/scanner-args.ts`): only known flags, every path they read or write
  inside the checkout (written paths never through a symlink), Opengrep rules from `{rules}` or a local file,
  Gitleaks on a `{base}..{head}` range, osv-scanner `--offline`. `vtc calibrate` prints each
  scanner's argv before anything runs. Scanner config files a diff changed (`.gitleaksignore`,
  `osv-scanner.toml`, `.semgrepignore`, `.checkov.yaml`, …) are put back to their base version
  while the scanners run, and L5 reports them as `new_suppression`.
- The osv-scanner offline vulnerability database lives in `~/.vtc/osv-db/` and is downloaded only
  when the human accepts it in `vtc calibrate` (the only osv-scanner call with network access;
  the download time is recorded in `vtc-fetched.json`). Without it the dependency gate does not
  start and reports `infra`; calibration then drops it with a warning.
- `rules/opengrep/` holds VTC's own Opengrep rules, licensed MIT. They are embedded too
  (`packages/engine/src/gates/rules.ts`, kept equal by a test), written to
  `~/.vtc/rules/<hash>/` on first use and passed to Opengrep through the `{rules}` placeholder.
- No CodeQL engine, no bundled Semgrep-maintained rules; GPL/AGPL tools only as separate
  user-installed programs (§7.2 licensing).
- Per-project calibrated gates and the baseline live in the target repo's `.vtc/gates.yml`
  (validated by `GatesConfigSchema`), written by `vtc calibrate`.

Gate command placeholders (whole argv tokens are never passed through a shell):
`{base}` / `{head}` (the commits of the run; a command using them is range-scoped and is not
compared with the base again), `{changed}` (the changed files that exist in the checkout, as
separate arguments; the gate is skipped when there are none) and `{rules}` (the product ruleset
directory). Report paths are relative to the gate's working directory and should point under
`.vtc/state/`.

The gates of a run are the base commit's `.vtc/gates.yml`; only `vtc calibrate` reads the working
tree, and it tells the user to commit the file it writes. A base with no committed `gates.yml`
reports `error` / `infra`. When the request carries `gates_config_hash` (the SHA-256 of the
`gates.yml` bytes the run started with, spine §5 reading 46b) and the base's bytes hash
differently, nothing runs and the run reports `error` / `infra` with that reason. Calibration always protects every lint, test and scanner config glob
(`packages/engine/src/gates/protected-globs.ts`): L5 reports a changed or added file matching one
unless the task's `files_scope` names that exact path. Task-runner files that define a gate
command (`Makefile`, `GNUmakefile`, `*.mk`, `justfile`/`Justfile`/`.justfile`, `*.just`,
`Taskfile.y*ml`, `noxfile.py`; spine §5 reading 45) and the package-manager configs a gate run
through `npm`/`pnpm`/`yarn`/`bun` reads (`.npmrc` with `script-shell` or `node-options`, `.yarnrc`,
`.yarnrc.yml` and `.yarn/releases/**`/`.yarn/plugins/**`, `.pnpmfile.*`, `bunfig.toml`) are guarded
the same way, matched in any letter case, even when a project's own `protected_configs` leaves them
out, and L1 runs with their base version. `pyproject.toml`, `package.json` and
`pnpm-workspace.yaml` also hold dependencies, so only their tool sections are guarded
(`mixed-configs.ts`: `[tool.ruff]`, `[tool.pytest]`, `[tool.mypy]`, `[tool.coverage]`, …, the task
runners `[tool.tox]`, `[tool.hatch.envs.*]`, `[tool.pdm.scripts]`, `[tool.poe]`; `scripts`,
`jest`, `eslintConfig`, `mocha`, `packageManager`, …; every pnpm setting, that is every top-level
key but `packages`, `catalog` and `catalogs`): L5 reports a diff that changes one, and L1 runs
with the head file whose tool sections are put back to the base version. Table headers are decoded
the way TOML decodes them (quoted keys, `\uXXXX` escapes), and a header line that does not decode
makes the whole file guarded (fail closed).

Hidden acceptance tests (§7.3) are copied in only for `include_hidden` runs: a task run copies its
own task's, and a feature's Final Review run copies those of every task in `hidden_tasks` (§6.7a
step 2). Two tasks with a hidden test at the same path stop the run with `infra` rather than lose
one. With no task named, evidence says nothing was copied, and `finalReviewStepsCovered`
(`@vtc/shared`) does not report step 2.

Install-phase gates (`phase: install`, proposed by calibrate from the lockfiles) are the engine-run
dependency install of spine §5 reading 49: they run first, everything after a failed install is
`skipped`, and the base checkout of the baseline comparison runs them too. No role installs
dependencies.

Dotenv files the package managers load on their own (`.env.yarn`, `.env`, `.env.local`,
`.env.test*`, `.env.development*`, `.env.production*`; not `.env.example`) are gate-command files
too (D-am, spine §5 reading 70): Yarn 4 injects `.env.yarn` into every `yarn run` and Bun loads
the others, so a `NODE_OPTIONS=--require …` there would preload diff-controlled code. L5 flags a
change to one in any letter case unless `files_scope` names the exact path, and L1 runs with the
base version (or without the file when the base has none).

## The gate sandbox (D-al, spine §5 reading 69)

Every command the Gate Runner starts runs in an OS sandbox (`packages/engine/src/gates/sandbox.ts`):
both calibration runs, every layer, guard and Final Review runs, the baseline runs on the base
checkout and the OSV database download.

- macOS: `/usr/bin/sandbox-exec` with a profile VTC generates per command (paths passed as `-D`
  parameters). The profile starts from `(deny default)`: a command may fork and exec, read files
  (narrowed below), signal and inspect only its own sandbox, and look up a short list of system
  services (`GATE_MACH_SERVICES`: user lookups, logging, notifications; DNS, network
  configuration and certificate trust in the install phase). LaunchServices, AppleEvents,
  `nsurlsessiond`, the pasteboard and the keychain are unreachable, so a gate cannot have launchd
  start code outside the sandbox (`open` of a checkout-built `.app`, `osascript`, `launchctl
submit`). Every command runs under an in-sandbox reaper (`REAPER_SCRIPT`): when the command
  ends or times out, it kills everything left in the sandbox (`kill -KILL -1`, which the profile
  confines to the sandbox) and confirms; without the confirmation the gate reports infra and the
  run starts no further command.
- Linux: `bwrap` with a minimal root: `/usr`, `/bin`, `/lib*`, `/etc`, `/opt`, `/nix`, `/snap`
  and `/sys` read-only, a fresh `/tmp`, the toolchains and the repo's git directory read-only,
  the checkout and private directories writable; never the host root, so the host's `/run`
  (D-Bus session bus, `systemd --user`), `/tmp/.X11-unix`, `/var/run/docker.sock` and agent
  sockets do not exist inside. Its own PID, IPC and UTS namespaces (everything dies with the
  command) and never the host's network namespace, so the host's abstract Unix sockets (an X
  server's `@/tmp/.X11-unix/X0`, a `unix:abstract=` D-Bus bus), which belong to a network
  namespace rather than to the filesystem, do not exist inside: the verify phase gets bwrap's own
  (`--unshare-net`, a private loopback only), the install phase runs as
  `pasta PASTA_ARGS -- bwrap --unshare-user --uid <uid> --gid <gid> …`, in the namespace pasta
  creates with user-mode IP networking, no port forwarding either way (`-t`/`-u`/`-T`/`-U none`,
  so no host loopback listener such as the engine is mirrored in), no gateway mapped to the host's
  loopback (`--no-map-gw`), and DNS through pasta's forwarder (`--dns-forward 169.254.1.1`, named
  by a jail-written `resolv.conf` mounted where `/etc/resolv.conf` points). Without `pasta`
  (package `passt`), or when it cannot start bwrap, verify-phase gates still run in bwrap and
  only install-phase gates refuse (they park as `infra`; `vtc doctor` warns; D-aw, spine §5
  reading 85).
- Verify phase: no network (Unix sockets only inside the writable directories). With
  `sandbox.verify_loopback: true` in `.vtc/gates.yml`, which only the human's yes at `vtc
calibrate`'s confirmation writes, the macOS verify phase may open sockets to `localhost`
  (127.0.0.1 and ::1) and nothing else (D-av, spine §5 reading 84). Install phase: IP networking
  (neither tool can filter by registry host; `WrappedGateCommand.network` says `full`) with the
  same filesystem rules, never the host's loopback (macOS denies `localhost`; pasta maps none);
  on macOS no Unix socket outside the writable directories except DNS (`mDNSResponder`), so not
  the engine socket under `~/.vtc/run`, an ssh or gpg agent, or Docker; on Linux no host Unix
  socket at all, pathname or abstract.
- Install-phase gates run first, as one batch, and the hidden acceptance tests are copied into
  the checkout only after all of them: no command with network access runs while they are there.
- Writes only to the verification checkout, the command's private temp directory and the run's
  `HOME`. `HOME` is an empty per-run directory under the OS temp directory (mode 0700, removed
  after the run); `TMPDIR`/`TMP`/`TEMP` point at a fresh directory per command; `VTC_HOME` and
  the cache variables that point outside (`GOPATH`, `GOCACHE`, `GOMODCACHE`, `CARGO_HOME`) are
  dropped, so tools fall back to the per-run `HOME`. The environment stays the `exec.ts` allowlist.
  No terminal is writable or readable (`/dev/tty`, `/dev/ttys*`).
- Reads (`gateReadPolicy`; nothing opens the paths): the real home (`$HOME` and the account's
  home) and the repo's `.vtc/state` (other checkouts, raw logs of hidden-test runs) are hidden,
  except the toolchains (absolute `PATH` entries, the parent of a `bin`/`sbin`/`shims` entry, and
  `NVM_DIR`, `PNPM_HOME`, `RUSTUP_HOME`, `JAVA_HOME`, … in `TOOLCHAIN_ROOT_ENV`), the VTC home's
  `scanners/`, `rules/` and `osv-db/`, the repo's git directory and the command's own checkout.
  On macOS names and metadata in hidden directories stay visible (paths must resolve through
  them); on Linux they are not mounted at all. Denied outright (`gateDenyReadPaths`): the rest of
  the VTC home, the Claude Code and Codex config directories (`$CLAUDE_CONFIG_DIR`/`$CODEX_HOME`
  or their defaults) and the credential files in them (`hostCredentialDenyReadPaths`), common
  credential stores under the home (`.ssh`, `.aws`, `.netrc`, `.npmrc`, `.yarnrc.yml`,
  `.cargo/credentials.toml`, `.docker`, `.kube`, `.gnupg`, `.pgpass`, `Library/Keychains`, …),
  even inside a toolchain root, and the repo's `.vtc/evidence`.
- `detectGateSandbox()` finds the sandbox with a short no-op probe (it fails when user namespaces
  are disabled, or when VTC already runs inside a sandbox that forbids nesting) and says why in
  one line; `vtc doctor` shows it. Tests inject a fake wrapper (`GateRunnerDeps.sandbox`); the
  one live test runs real `sandbox-exec` with `VTC_LIVE_SANDBOX=1`, fast and without network.
- No sandbox: nothing runs. Each gate reports `error` / `infra` with "no OS sandbox for gates"
  (`GATE_SANDBOX.noSandboxReason`) in its evidence, and `vtc calibrate` refuses before it asks
  anything. The only way past it is `gates.allow_unsandboxed: true` in `~/.vtc/config.yaml`
  (never `project.yaml`): commands then run unconfined (same environment rules), the report says
  `sandbox: "none"`, evidence notes it, and engine core records an `unsandboxed_gate` incident.
  Every report that ran a command names its sandbox (`GateReport.sandbox`).
- Known limits: on macOS the verify phase refuses loopback sockets by default (the host's
  loopback is shared with the engine and other local services), so a test suite that starts a
  localhost server fails there unless the human said yes to the loopback question at `vtc
calibrate`, while on Linux it gets a private loopback. Unix sockets inside the
  writable directories work. A gate cannot write the repo's shared git directory, and private
  registries that need credentials from the user's `.npmrc` or environment do not install. On
  macOS, file watching through FSEvents and anything else that needs an unlisted system service
  fails in a gate. Neither platform's install phase reaches the host's loopback services. The pasta path has unit tests of its argv only; no live
  test runs it. The reaper confirms before its `kill`, so a gate that kills it in the microseconds between the
  two is not detected. Under `gates.allow_unsandboxed` nothing of this applies.

## Not built yet (tracked follow-up increments)

- **Registry-only install network and sandbox denials.** The install phase gets the full
  network (no host-level registry filter exists in `sandbox-exec` or `bwrap`), and a gate that
  fails because the sandbox refused something (`EPERM`, "Operation not permitted") is classified
  like any other failure: §7.6 rule 12 "sandbox denials" has no separate signal yet.
- **Task-runner includes.** A guarded task-runner file can include another file by any name
  (`include` in make, `import`/`mod` in just, `includes:` in Taskfile, a module noxfile.py
  imports); only `*.mk` and `*.just` are covered by name. Entry points a diff adds under
  `[project.scripts]` could also shadow a gate's command after an install.
- **L3 detection.** Calibrate proposes no diff-cover gate and `line_coverage_pct` is always
  `null`, so the coverage part of the monotonic rule applies only to a hand-written L3 gate's
  `diff_coverage_pct`.
- **Scope creep (§7.4).** `traceability.json` always has `scope_creep: []` (it needs per-test
  coverage contexts); every run writes a `traceability.log` note saying it was not computed.
