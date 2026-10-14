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
  `scanners/`, `rules/`, `osv-db/` and `browsers/` (AD-24), the repo's git directory and the
  command's own checkout. A command may name extra read-only roots (`JailedRequest.allowRead`:
  the visual runner's Playwright cache); the deny list still wins.
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

## L6 compiled from the Architect's AD Checks (§8.5)

Besides the calibrated L6 gates (an external fitness tool in `gates.yml`), every run that includes
L6 compiles the approved spine's Checks (`packages/engine/src/gates/arch/`). The spine is read at
the base commit (`.vtc/architecture/spine.md`), so a diff cannot loosen its own Checks. Under an
`AD-n` heading, each fenced `vtc-check` block (YAML) is one L6 result `vtc-ad-<n>[-<k>]`,
`blocking` or `warn` (non-blocking) as its `mode` says:

- `import-boundary`: files matching `from` (minus `except`) may not import files matching
  `forbid` (relative JS/TS and Python imports, resolved with extensions and index files) or the
  packages in `forbid_packages`;
- `forbidden-dependency`: no `package.json`, `requirements*.txt`, `pyproject.toml` or `go.mod`
  may add one of `packages`;
- `forbidden-pattern`: a regular expression no line of the files matching `paths` may match.

Only new violations count: one the same file already had at the base is baseline. Findings are
`ToolFinding`s with rule id `vtc-arch/AD-n`, category `architecture`. A block that does not parse
reports `error` / `infra` (a Check never silently stops running). A `forbidden-pattern` runs in
the engine process, where a match cannot be interrupted, so it is bounded: a pattern that can
backtrack catastrophically (a backreference, a repeated group that repeats inside or holds an
alternation, more than two unbounded quantifiers) does not compile (`error` / `infra`), each line
is matched on its first 500 characters, and one Check may spend 5 seconds over all changed
files, checked between lines; running out of it is `error` / `infra` too. A time-bounded
`node:vm` match is proposed to the integrator (`vm` is not in the runtime-safe built-ins). The
block format is provisional until it is frozen in `@vtc/shared` and taught to the Architect
(contract proposal).

## Scope creep (§7.4)

Every run that executed L2 for a task or feature computes `scope_creep` for `traceability.json`:
the changed JS/TS/Python files that no test tagged with the run's requirements (any REQ tag when
the request names none) is in, or reaches through relative imports (a bounded walk from the
tagged tests' source files, the deterministic stand-in for per-test coverage contexts). A test's
file is the JUnit `file` attribute, a path classname, the path of a pytest node id, or the
longest existing module path of a pytest dotted classname (`tests.test_models` →
`tests/test_models.py`, pytest's default xunit2 output). When a tagged test's file cannot be
found, coverage is incomplete and nothing is flagged: the uncovered files are listed as unjudged.
Other files are not judged; the `traceability.log` note lists them. Each flagged path is one
`ToolFinding` (`SCOPE_CREEP_RULE_ID`, category `spec_mismatch`, SARIF level `none`) on the run's
last L2 result, which keeps its status: triage makes it `info` and defers it. The frozen
`GateResultSchema` allows no more findings than `new_violations`, so that result's
`new_violations` counts them too (contract proposal: a separate count for info findings).

## The deterministic visual step (AD-24, §7.5, §9.1, D-ay)

A request with `visual` (`screens: []` = the full matrix) gets `GateReport.visual` (a
`VisualSummary`) and a `VisualReport` at `.vtc/evidence/<T-n|F-n>/gates/<attempt>/visual/
report.json`, with the screenshots and diff images beside it. It never changes `verdict`.
Settings: `gates.yml` `visual` (`visualConfigFor`). `screens.yaml`, `tokens.json` and the
approved prototype (`.vtc/design/prototype/`) are read at the base commit, so neither the diff
nor project code (earlier gates, the app server) can change the reference: the prototype
comes from a clean checkout of the base made for the step, which no gate command ran in and
which the sandboxed runner may read but not write; `source_hash` covers its bytes.

The result is trusted only as far as the code that computed it. The app server runs in the
runner's sandbox and can write the runner's temp directory (and a process it detaches can
outlive it until the reaper), so the runner reads and deletes a per-run random key before it
imports anything or starts the app, writes its result once, at the end, as an envelope with an
HMAC-SHA256 under that key, and lists the SHA-256 of every image it wrote. A result without a
valid MAC, or an image that is missing or changed, is `error` and never read as a verdict.
The runner itself is out of the app server's reach (reading 124): Node runs with
`--disable-sigusr1` (Node 22.14 or later; the script refuses to start without it), so a signal
cannot open its inspector; the app runs detached, in a session and process group of its own;
the interpreter is the engine's own Node when it has the flag, else an absolute `node` from a
`PATH` entry outside the repository and the checkout (none: `error`; known limit: a
version-manager shim there, such as Volta, asdf or mise, picks its interpreter and, with mise,
an environment from config files in the checkout under review); and on Linux, where a same-user process can attach to another through
ptrace unless Yama limits it to descendants, a render runs only with `kernel.yama.ptrace_scope`
1 or higher (else nothing renders and the step is `skipped`, its `skipped_reason` naming the
sysctl: a visible note at Levels 1–2, never a Level-3 pass; reading 164, D-bj). axe, the computed styles, the region lookup and
the font wait run in an isolated world of the runner's own (CDP `Page.createIsolatedWorld`), so
the page under review cannot replace `window.axe`, `getComputedStyle` or
`getBoundingClientRect`; the prototype origin is served only to the reference context (the
implementation's requests to it are aborted, so it cannot load the prototype through that
origin; known limit: the app server shares the sandbox, which may read the prototype, so it
could serve the same bytes from its own origin). On the
doctor-installed store's Playwright, preferred whenever it is installed (reading 124), the
comparison code is VTC's. Without a store the project's own Playwright runs, and the runner
process loads `playwright-core` from the verification checkout, which the change under review
can modify (install scripts run there), so every such run carries a note under its own rule,
`vtc-visual/project-toolchain`, saying the comparison ran on project-controlled code. Notes come
first in the findings, so the summary's 200-finding cap never drops one. Every step that chose a
toolchain sets `toolchain` on both `VisualSummary` and `VisualReport` (contracts 4.7.0): `vtc`
for the store, `project` for the project's Playwright, whatever the status; a step that stopped
before choosing one (no browser) leaves it out. Engine core reads it (`level3VisualStatus`), so a
`pass` on `project` does not satisfy the Level-3 Final Review item (reading 124);
`ranOnProjectToolchain` in `gates/visual/` serves the gate runner's own tests.

1. Token lint (`vtc-token/<kind>`) on the lines the diff added to UI files: literal colours (OKLab
   ΔE over `color_delta` from every colour token), spacing and radii off the token scale, font
   families and shadows that are not tokens. Custom properties and `var()` are fine.
2. The design detector (`vtc-design/<id>`, Designer): twelve source-level slop rules ported from
   Apache-2.0 impeccable (`THIRD_PARTY/impeccable/`, `NOTICE`), each with a flag and a pass
   fixture. Advisory rules report SARIF `note` and do not fail the step.
3. The browser: the store `vtc doctor --install-browser` fills (`~/.vtc/browsers/node_modules/`
   and `BROWSER_PIN_FILE`) when it is installed, else the project's own Playwright (resolved
   inside the checkout, its browser in the user's Playwright cache, pinned per executable path
   on first use under `~/.vtc/browsers/projects/<repo-key>/<path-hash>.json`, which the report
   shows as a `vtc-visual/note`). The executable is re-hashed against its pin before every run; a
   mismatch, an unreadable pin or a pin for another path is `error`. A path seen before is never
   re-pinned. axe-core and pixelmatch come from the store when it has them, else from the
   project. No Playwright, or the project's Playwright with no browser installed: `skipped` with
   `VISUAL_SKIPPED_NO_BROWSER`. The project's Playwright installed but its probe failing (a
   crash, no sandbox): `error`. Nothing is downloaded here.
4. The app server: `visual.app` in `gates.yml` (`command`, a loopback `url`, `cwd`,
   `ready_timeout_s`), allowlisted like a gate. It is read and written only through the typed
   config (`GatesConfig.visual.app`, `VisualApp`, contracts 4.6.0), so an invalid one makes
   `gates.yml` invalid as a whole: the run is gate infrastructure and nothing renders.
   `vtc calibrate` proposes one from the package.json `dev`, `start` or `preview` script (its
   `--port`/`-p`/`PORT=` or the server's default port, on `http://localhost`), and only a human's
   yes writes it and puts its argv in the allowlist; the one in a readable `gates.yml`, written
   by hand or confirmed earlier, is kept on re-calibration with every other `visual` setting.
   Without one, or with one not allowlisted, the step is `error` (gate infrastructure: a human
   sets it up; reading 162, D-bh).
5. The render matrix runs as one gate command in the sandbox (verify phase; on macOS the host
   loopback is opened at the app server's own port only, `GateJailSpec.loopbackPorts`, never
   the engine API or a service on another port, and `vtc calibrate`'s question names that port;
   a service already listening on that very port would be reachable, so the runner first checks
   that nothing answers there and otherwise ends the run as `error` ("port N is already in
   use"), takes readiness only from a live child, and ends as `error` when the app exits
   mid-run; on Linux the loopback is the sandbox's own): VTC's runner script (`runner-script.ts`) in the
   command's private temp directory. Per job it renders the app at `<url><route>?state=&theme=` and the
   base prototype (served through request interception) in the same run with the same
   browser: headless, DPR 1, `en-US`, `UTC`, a fixed clock, reduced motion, fonts ready,
   animations and the caret off, non-loopback requests aborted, `dynamic_regions` masked. Then
   axe (`axe/<rule>`, an unmodified `axe.min.js` from the store or the project, never bundled),
   computed styles against the tokens (`vtc-style/<property>`) and a pixelmatch diff per region
   (`data-vtc-region` or landmarks; `vtc-layout/pixels` over `region_budget_pct`,
   `vtc-layout/dimensions` for other sizes).
6. Status: `error` (runner failed, or its result or images fail the MAC and hash checks) > `fail` (a blocking finding) > `unchecked` (an unreached
   render or screen, an axe `incomplete` item, a check that could not run: never clean) > `pass`.
   A step that rendered nothing on purpose (no browser, or Linux `ptrace_scope` 0) is `skipped`
   with its reason, or `fail` when a token-lint or detector finding blocks.
   Each axe `incomplete` rule per screen state is a note-level `axe/<rule>` finding that names
   what needs review. Every finding's location is `.vtc/design/screens.yaml` with the screen
   state, render key and region, selector or note as its symbol, so it keeps its fingerprint
   from run to run (waivers, deferrals and "reappeared" match); the run's screenshot or diff
   image is its `evidence.ref`.
7. Evidence: the screenshots, references and diff images go into the git-tracked evidence
   unredacted (redaction works on text; an image cannot be redacted). This is an exemption from
   AD-18 rule 1 recorded here and proposed to the integrator as a spine reading: a page the app
   server renders could show a secret the app prints. Per run at most 64 MiB of images are
   copied, diff images first; whatever is left out is a `vtc-visual/note` (the verdict is
   computed from the runner's data, so it is unaffected).

The novelty check (`visual/novelty.ts`, §9.1 step 4, reading 107) compares a direction's first
viewport (64-bit dHash) and token vector (OKLCH palette, type pair, radius, density) with the
per-client design library `~/.vtc/design-library/<scope>/`; `too_similar` only when both are
under their thresholds, judged over the whole library (the report lists the ten nearest,
too-similar ones first). `recordDesignChoice` adds the chosen direction. The Gate Runner
exposes both as the optional `GateRunner.checkNovelty` / `recordDesignChoice` (contracts 4.6.0,
reading 127): the first viewport is read from the repo's working tree (a missing, oversized,
symlinked or escaping path gives `unchecked`), the token vector from `.vtc/design/tokens.json`
(none yet: empty tokens), and the library is the request's `ResearchScope` only (`_shared` or
`client-<slug>`; a malformed scope, direction or entry rejects). Engine core writes the report
to `noveltyReportPath` and calls `recordDesignChoice` when the human picks at G2.

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
- **Visual step, live.** No test runs a real browser: Chromium inside `sandbox-exec`/`bwrap`
  (its own sandbox is off, `chromiumSandbox: false`, so the gate sandbox is the only boundary
  around the untrusted page; the macOS profile may need more system services) is a spike, and
  an opt-in live test needs a local `playwright-core`, which this repo does not install. The
  render cache keyed by `source_hash` is not used yet (every run renders, and every attempt
  copies its images, up to the per-run cap). The detector ports the source-level slop rules
  only (no live-DOM, quality or design-system drift rules). Engine core does not call the
  novelty seam yet, so every direction stays `unchecked` until it does (reading 127).
- **Visual app server detection** knows the default ports of common dev and preview servers
  (Vite, Next, Nuxt, Astro, Angular, webpack, Create React App) and the explicit `--port`,
  `-p` and `PORT=` forms; any other server needs `visual.app` written by hand and confirmed with
  `vtc calibrate`.
- **Scope creep** reads no per-test coverage contexts and judges only JS/TS/Python files.
