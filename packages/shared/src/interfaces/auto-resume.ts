/**
 * Auto-resume timer seam (§6.9 step 4, AD-12, spine §5 reading 59). The engine decides when to
 * wake; the cli implements it and injects it; a `HostAdapter` never installs it. The cli persists
 * one wake record per repo (`~/.vtc/wake/<repo-key>.json`); a single launchd agent on macOS,
 * installed only by an explicit `vtc install --auto-resume`, runs `vtc engine --wake-due` every
 * 60 s, which starts `vtc engine --daemon --wake` for each initialised repo that is due. The daemon
 * never runs `launchctl`. Windows has no timer in v1 (reading 56).
 */
export interface AutoResumeScheduler {
  /** Schedule (or move) the single wake-up for a repo. `at` already includes the 1–2 min jitter. */
  schedule(repoRoot: string, at: Date): Promise<void>;
  /** Cancel the repo's pending wake-up, if any. Idempotent. */
  cancel(repoRoot: string): Promise<void>;
}
