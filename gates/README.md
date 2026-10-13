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
    Opengrep 1.30.1 (LGPL-2.1, run as a separate program), Checkov 3.3.20 (Apache-2.0; no
    darwin-arm64 build is published, so on Apple silicon it must be installed by the user and
    confirmed in `vtc calibrate`).
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
tree. Calibration always protects every lint, test and scanner config glob
(`packages/engine/src/gates/protected-globs.ts`): L5 reports a changed or added file matching one
unless the task's `files_scope` names that exact path. `pyproject.toml` and `package.json` also
hold dependencies, so only their tool sections are guarded (`mixed-configs.ts`: `[tool.ruff]`,
`[tool.pytest]`, `[tool.mypy]`, `[tool.coverage]`, … and `scripts`, `jest`, `eslintConfig`,
`mocha`, …): L5 reports a diff that changes one, and L1 runs with the head file whose tool
sections are put back to the base version.

## Not built yet (tracked follow-up increments)

- **Two-phase sandbox (§7.2).** Install should reach package registries only and test/scan should
  have no network. Today every gate runs with the user's network and file access
  (`exec.ts` `runCommand`), so §7.6 rule 12 "sandbox denials" never fires.
  `runner.test.ts` keeps `it.todo` entries for it.
- **Hidden tests in a feature's Final Review (§6.7a step 2).** `GateRunRequest` does not name a
  feature's tasks, so a feature run copies no hidden tests (evidence says so) and
  `finalReviewStepsCovered` does not report step 2 (contract proposal: a `hidden_tasks` field).
- **L3 detection.** Calibrate proposes no diff-cover gate and `line_coverage_pct` is always
  `null`, so the coverage part of the monotonic rule applies only to a hand-written L3 gate's
  `diff_coverage_pct`.
- **Scope creep (§7.4).** `traceability.json` always has `scope_creep: []` (it needs per-test
  coverage contexts); every run writes a `traceability.log` note saying it was not computed.
