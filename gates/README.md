# gates/

Gate definitions, scanner pins and MIT rulesets (spec §4.4, §7). Owned by the gate-runner team
(AD-15).

- `scanners.json` (validated by `ScannerPinsSchema` in `@vtc/shared`): each scanner pinned by
  version, an https download URL template and a SHA-256 **per platform**. Embedded in the binary;
  `vtc doctor` downloads into `~/.vtc/` and verifies the checksum. Never auto-updated (§7.2, §15).
- No CodeQL engine, no bundled Semgrep-maintained rules; GPL/AGPL tools only as separate
  user-installed programs (§7.2 licensing).
- Per-project calibrated gates and the baseline live in the target repo's `.vtc/gates.yml`
  (validated by `GatesConfigSchema`).

Populated in sub-project 2.
