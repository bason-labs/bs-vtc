/**
 * Auto-resume timer seam (§6.9 step 4, AD-12). The engine decides when to wake; the cli
 * implements the OS timer that survives restarts (a launchd agent on macOS, installed by
 * `vtc install`) and injects it; a `HostAdapter` never installs it. The timer starts
 * `vtc engine --daemon --wake` for the repo.
 */
export interface AutoResumeScheduler {
  /** Schedule (or move) the single wake-up for a repo. `at` already includes the 1–2 min jitter. */
  schedule(repoRoot: string, at: Date): Promise<void>;
  /** Cancel the repo's pending wake-up, if any. Idempotent. */
  cancel(repoRoot: string): Promise<void>;
}
