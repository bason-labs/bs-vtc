# gates/

Gate definitions, scanner pins (version + SHA-256) and MIT rulesets (spec §4.4, §7).

- Scanners are pinned by version and SHA-256 and never auto-updated (§7.2, §15).
- No CodeQL engine, no bundled Semgrep-maintained rules; GPL/AGPL tools only as separate
  user-installed programs (§7.2 licensing).
- Per-project calibrated gates live in the target repo's `.vtc/gates.yml`
  (validated by `GatesConfigSchema` in `@vtc/shared`).

Populated in sub-project 2.
