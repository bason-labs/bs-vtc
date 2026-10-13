# gates/

Gate definitions, scanner pins and MIT rulesets (spec §4.4, §7). Owned by the gate-runner team
(AD-15). The Gate Runner itself lives in `packages/engine/src/gates/`.

- `scanners.json` (validated by `ScannerPinsSchema` in `@vtc/shared`): each scanner pinned by
  version, an https download URL template and a SHA-256 **per platform**, copied from the
  release's published checksums. The same pins are embedded in the binary
  (`packages/engine/src/gates/scanner-pins.ts`, which also maps each platform to the release's
  asset name); a test keeps the two equal. Scanners are downloaded on demand into
  `~/.vtc/scanners/<name>/<version>/<platform>/`, verified against the pin before anything is
  unpacked, and re-verified before every use. Never auto-updated (§7.2, §15).
  - Gitleaks 8.30.1 (MIT), osv-scanner 2.6.0 (Apache-2.0, always run with `--offline`),
    Opengrep 1.30.1 (LGPL-2.1, downloaded on demand, SHA-verified and run only as a separate
    program; spine §5 reading 40), Checkov 3.3.20 (Apache-2.0).
  - Checkov publishes no darwin-arm64 build and VTC pins no Rosetta one (spine §5 reading 41).
    There it is user-installed: the store rejects it with `ScannerUnavailableError`, `vtc doctor`
    warns, and the Gate Runner runs the user's own `checkov` from an absolute `PATH` entry outside
    the repo (never a relative entry or a file in the repo or a checkout, which a diff controls;
    evidence notes that it was not SHA-verified). When there is none, the L4 IaC gate is `skipped`
    with a visible `skipped_reason`. Every other platform keeps its pin.
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
`Taskfile.y*ml`, `noxfile.py`; spine §5 reading 45) are guarded the same way, matched in any letter
case, even when a project's own `protected_configs` leaves them out, and L1 runs with their base
version. `pyproject.toml` and `package.json` also hold dependencies, so only their tool sections
are guarded (`mixed-configs.ts`: `[tool.ruff]`, `[tool.pytest]`, `[tool.mypy]`, `[tool.coverage]`,
…, the task runners `[tool.tox]`, `[tool.hatch.envs.*]`, `[tool.pdm.scripts]`, `[tool.poe]`, and
`scripts`, `jest`, `eslintConfig`, `mocha`, …): L5 reports a diff that changes one, and L1 runs
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

## Not built yet (tracked follow-up increments)

- **Two-phase sandbox (§7.2).** The install phase exists (above), but nothing yet confines its
  network to package registries, and verify-phase gates are not cut off from the network: every
  gate runs with the user's network and file access (`exec.ts` `runCommand`), so §7.6 rule 12
  "sandbox denials" never fires. `runner.test.ts` keeps `it.todo` entries for it.
- **Task-runner includes.** A guarded task-runner file can include another file by any name
  (`include` in make, `import`/`mod` in just, `includes:` in Taskfile, a module noxfile.py
  imports); only `*.mk` and `*.just` are covered by name. Entry points a diff adds under
  `[project.scripts]` could also shadow a gate's command after an install.
- **L3 detection.** Calibrate proposes no diff-cover gate and `line_coverage_pct` is always
  `null`, so the coverage part of the monotonic rule applies only to a hand-written L3 gate's
  `diff_coverage_pct`.
- **Scope creep (§7.4).** `traceability.json` always has `scope_creep: []` (it needs per-test
  coverage contexts); every run writes a `traceability.log` note saying it was not computed.
