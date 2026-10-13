/** The record the engine keeps of every dispatch (`dispatch-guard.ts`, AD-7 rule 7). */
export interface DispatchRecord {
  readonly v: 3;
  readonly run: string;
  readonly action_id: string;
  /** `gitConfigFingerprint` of the repo at dispatch. */
  readonly git: Readonly<Record<string, string>>;
  /** The engine's own files (`ENGINE_FILE_DIRS`) → content hash, at dispatch. */
  readonly state: Readonly<Record<string, string>>;
  /** A front-half role or advisor: its own worktree and the commit it started from. */
  readonly worktree?: { readonly path: string; readonly base: string };
}
