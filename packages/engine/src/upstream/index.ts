/**
 * Upstream (AD-27; owner: upstream team): automatic issues and PRs in VTC's own repo and in the
 * project's repo, and their evidence. `createUpstream(deps)` is the factory the daemon wires
 * (`EngineDeps.automation`); nothing but the daemon imports this module (AD-27 rule 8). It reaches
 * engine core only through its index and GitHub, git plumbing and evidence capture only through the
 * `@vtc/shared` seams.
 */
export { createUpstream } from "./upstream.js";
export type {
  AutomationOutcome,
  AutomationState,
  AutoPrInput,
  ProjectContext,
  PrSource,
  Upstream,
  UpstreamDeps,
  UpstreamEvent,
  UpstreamEventType,
} from "./upstream.js";
export * from "./body.js";
export * from "./decisions.js";
export * from "./evidence/gif.js";
export * from "./evidence/hosting.js";
export * from "./evidence/manifest.js";
export * from "./evidence/pipeline.js";
export * from "./evidence/plan.js";
export * from "./evidence/snapshot-server.js";
export * from "./evidence/upstream-snapshot.js";
export * from "./file-lock.js";
export * from "./fingerprint.js";
export * from "./gh.js";
export * from "./gh-services.js";
export * from "./ledger.js";
export * from "./lookback-pr.js";
export * from "./privacy.js";
export * from "./queue.js";
export * from "./remote-refs.js";
export * from "./report-render.js";
export * from "./routing-pr.js";
export * from "./safe-fs.js";
export * from "./skip.js";
export * from "./staging.js";
export * from "./state-dir.js";
export * from "./subject.js";
export * from "./triggers.js";
export * from "./ui-paths.js";
